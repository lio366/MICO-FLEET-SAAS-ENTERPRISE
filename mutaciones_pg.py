#!/usr/bin/env python3
"""Pruebas de mutación de la integración PostgreSQL (T1–T13).

Para cada mutación: copia los archivos versionados a un directorio temporal, aplica UN
cambio que desactiva una protección concreta, ejecuta run_native_pg16.sh sobre un clúster
PostgreSQL 16 desechable y exige que alguna prueba falle. Una mutación que sobrevive
(todas las pruebas pasan) significa que la suite no protege esa propiedad.

Uso:   python3 -I tests/integration/mutaciones_pg.py [--puerto 55436] [--solo NOMBRE ...]
Salida: tabla de resultados; exit 0 si todas las mutaciones son detectadas, 1 si alguna sobrevive,
        2 si una mutación es inválida (su patrón ya no existe exactamente una vez en el código),
        3 si el entorno está incompleto, 4 si alguna ejecución falló sin que fallara ninguna prueba.
Requiere lo mismo que run_native_pg16.sh (PostgreSQL 16, node, openssl y el módulo pg).
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
FIN = object()  # marcador: añadir al final del archivo

# (nombre, archivo, patrón exacto, reemplazo, prueba que debe detectarla)
MUTACIONES = [
    ("hash_sin_recalculo", "42_audit_ledger.js",
     "if (sha256(payload) !== r.hash)",
     "if (false && sha256(payload) !== r.hash)", "T8"),
    ("gate_dr_sin_cadena", "42_audit_ledger.js",
     "if (!integridad.ok) throw new Error(`DR_LEDGER_INVALIDO",
     "if (false) throw new Error(`DR_LEDGER_INVALIDO", "T8"),
    ("sin_resolucion_commit_ambiguo", "42_audit_ledger.js",
     "      } catch (ce) {\n        await client.query('ROLLBACK').catch(() => {});",
     "      } catch (ce) { throw ce;\n        await client.query('ROLLBACK').catch(() => {});", "T10"),
    ("trigger_inmutable_eliminado", "sql/42_audit_ledger.sql",
     "CREATE TRIGGER trg_ledger_no_update BEFORE UPDATE OR DELETE ON audit_ledger\n"
     "  FOR EACH ROW EXECUTE FUNCTION audit_ledger_inmutable();",
     "SELECT 1;", "T5"),
    ("roles_ledger_con_update", "sql/42_audit_ledger_roles.sql",
     "REVOKE UPDATE, DELETE, TRUNCATE ON audit_ledger, audit_checkpoints FROM mf_app;",
     "GRANT UPDATE ON audit_ledger TO mf_app;", "T5"),
    ("rls_off_drivers", "infra/postgres/003_app_grants.sql", FIN,
     "ALTER TABLE drivers NO FORCE ROW LEVEL SECURITY; ALTER TABLE drivers DISABLE ROW LEVEL SECURITY;", "T3"),
    ("dedup_anulado", "sql/42_audit_ledger.sql",
     "ON audit_ledger(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;",
     "ON audit_ledger(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL AND false;", "T4/T6"),
    ("firma_checkpoint_no_verifica", "42_audit_ledger.js",
     "    const firmaOk = evaluarFirma(cp, mensaje, clave);\n    if (!firmaOk.ok) {\n      await client.query('COMMIT');",
     "    const firmaOk = { ok: true };\n    if (!firmaOk.ok) {\n      await client.query('COMMIT');", "T7"),
    ("lider_candado_sesion", "47_scheduler_cluster.js",
     "    await client.query('BEGIN');\n    await client.query('SELECT pg_advisory_xact_lock($1)', [CANDADO_CLUSTER]);",
     "    await client.query('SELECT pg_advisory_lock($1)', [CANDADO_CLUSTER]);\n    await client.query('BEGIN');", "T12"),
    ("lider_sin_ttl", "47_scheduler_cluster.js",
     "if (liderVivo && liderVivo !== nodoId) {",
     "if (liderVivo && liderVivo !== nodoId && false) {", "T12"),
    ("llave64_sin_signo", "46_distributed_lock.js",
     "return BigInt.asIntN(64, BigInt('0x' + h.toString('hex', 0, 8))).toString();",
     "return BigInt('0x' + h.toString('hex', 0, 8)).toString();", "T13"),
    ("candado_noop", "46_distributed_lock.js",
     "await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [llave64(clave)]);",
     "await client.query('SELECT 1');", "T13"),
    # E-022 — operaciones v7
    ("tenant_ctx_omitido", "46_distributed_lock.js",
     "      await client.query(\"SELECT set_config('app.current_tenant', $1, true)\", [tenantId]);\n    }\n    const tomado",
     "    }\n    const tomado", "T14"),
    ("chofer_de_otra_empresa", "46_distributed_lock.js",
     "    if (!chofer.rows.length) return { asignada: false, motivo: 'El chofer no pertenece a esta empresa' };",
     "", "T14"),
    ("sin_indice_reserva_activa", "migrations/002_operaciones_v7.up.sql",
     "CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_carga_activa\n  ON bookings (load_id) WHERE status NOT IN ('REJECTED', 'CANCELLED');",
     "", "T14"),
    ("factura_sin_control_duplicado", "46_distributed_lock.js",
     "    if (duplicada.rows.length) return { facturada: false, motivo: 'Esta carga ya tiene factura', numero: duplicada.rows[0].numero };",
     "", "T14"),
    ("factura_de_carga_no_entregada", "46_distributed_lock.js",
     "    if (reserva.rows[0].status !== 'DELIVERED') return { facturada: false, motivo: 'Solo se factura una carga entregada' };",
     "", "T14"),
    # E-016 — rotación de claves
    ("kid_no_persistido", "42_audit_ledger.js",
     "[tenantId, rows[0].seq, rows[0].hash, firma, alg, kid]);\n    await client.query('COMMIT');",
     "[tenantId, rows[0].seq, rows[0].hash, firma, alg, null]);\n    await client.query('COMMIT');", "T15"),
    ("kid_ignorado_al_verificar", "42_audit_ledger.js",
     "    const key = llavero.get(cp.firma_kid);",
     "    const key = llavero.get(cp.firma_kid) || [...llavero.values()][0];", "T15"),
    # E-017 / E-023 — migraciones y arranque
    ("migrador_sin_orden_inverso", "db/migrador.js",
     "    if (ids[0] !== id) return { ok: false, motivo: `revertir en orden inverso: antes revertir ${ids[0]}` };",
     "", "T16"),
    ("rollback_001_sin_guardia", "migrations/001_ledger_v6.down.sql",
     "    RAISE EXCEPTION 'ROLLBACK_BLOQUEADO: existen checkpoints no HMAC; v5.4 no puede representarlos sin pérdida'\n      USING ERRCODE = 'P0001';",
     "    NULL;", "T16"),
    ("esquema_sin_candado", "db/migrador.js",
     "    await client.query('SELECT pg_advisory_xact_lock($1, $2)', CANDADO_MIGRACIONES);",
     "", "T16"),
    # E-025 / E-026 — webhooks de Twilio
    ("firma_twilio_no_verificada", "server/api/twilio_firma.js",
     "    if (!validarFirmaTwilio({ authToken, url, params: req.body || {}, firma })) {",
     "    if (false) {", "T17"),
    ("resolvedor_security_invoker", "migrations/004_resolucion_webhooks.up.sql",
     "RETURNS TABLE (driver_id uuid, tenant_id uuid)\nLANGUAGE sql STABLE SECURITY DEFINER",
     "RETURNS TABLE (driver_id uuid, tenant_id uuid)\nLANGUAGE sql STABLE SECURITY INVOKER", "T17"),
    ("resolvedor_acepta_empresa_suspendida", "migrations/004_resolucion_webhooks.up.sql",
     "    AND d.is_active IS TRUE\n    AND t.status IN ('TRIAL', 'ACTIVE')",
     "    AND d.is_active IS TRUE", "T17"),
    ("rechazo_no_libera_carga", "46_distributed_lock.js",
     "    if (!acepta && r.rows[0].load_id) {",
     "    if (false) {", "T17"),
    ("respuesta_sin_condicion_offered", "46_distributed_lock.js",
     "       WHERE id=$1 AND tenant_id=$2 AND status='OFFERED' RETURNING load_id`,",
     "       WHERE id=$1 AND tenant_id=$2 RETURNING load_id`,", "T17"),
    ("sms_responde_oferta_antigua", "server/services/ofertas.js",
     "    if (fila && (!mejor || new Date(fila.assigned_at || 0) > new Date(mejor.assigned_at || 0))) mejor = fila;",
     "    if (fila && !mejor) mejor = fila;", "T17"),
    # E-028 — API autenticada con RLS por petición
    ("token_de_otra_empresa_aceptado", "41_auth_rbac.js",
     "    if (!payload || payload.tid !== req.tenant.id) {",
     "    if (!payload) {", "T18"),
    ("contexto_de_sesion_en_pool", "server/http/contexto_tenant.js",
     "    await c.query(\"SELECT set_config('app.current_tenant', $1, true)\", [tenantId]);",
     "    await c.query(\"SELECT set_config('app.current_tenant', $1, false)\", [tenantId]);", "T18"),
    ("intentos_fallidos_no_registrados", "41_auth_rbac.js",
     "  await db.query(`INSERT INTO login_intentos (email, exito) VALUES ($1,$2)`, [correo, valido]);",
     "  if (valido) await db.query(`INSERT INTO login_intentos (email, exito) VALUES ($1,$2)`, [correo, valido]);", "T18"),
    ("limite_plan_fuera_de_contexto", "02_tenant_middleware.js",
     "                const { rows } = await ctx.enTenant(this.db, tenant.id,\n                    c => c.query(`SELECT count(*)::int AS n FROM ${def.tabla} WHERE ${def.filtro}`), { soloLectura: true });",
     "                const { rows } = await this.db.query(`SELECT count(*)::int AS n FROM ${def.tabla} WHERE ${def.filtro}`);", "T18"),
    ("ruta_consulta_sin_contexto", "server/api/routes.js",
     "      const { rows } = await req.enTenant((c) => c.query(\n        `SELECT id, full_name, phone, truck_number, mc_number, status, hos_status\n         FROM drivers WHERE is_active IS TRUE ORDER BY full_name`), { soloLectura: true });",
     "      const { rows } = await db.query(\n        `SELECT id, full_name, phone, truck_number, mc_number, status, hos_status\n         FROM drivers WHERE is_active IS TRUE ORDER BY full_name`);", "T18"),
    ("sesion_revocada_aceptada", "41_auth_rbac.js",
     "         WHERE s.token_hash=$1 AND s.user_id=$2 AND s.revocada IS FALSE AND s.expira_en > now() AND u.is_active IS TRUE`,",
     "         WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expira_en > now() AND u.is_active IS TRUE`,", "T18"),
    # E-031 — workers multiempresa
    ("bus_publica_aunque_falle", "44_event_bus.js",
     "  if (!errores.length) {\n    await ctx.db.query(",
     "  if (true) {\n    await ctx.db.query(", "T19"),
    ("bus_sin_cola_de_fallidos", "44_event_bus.js",
     "  const agotado = evento.intentos >= MAX_INTENTOS;",
     "  const agotado = false;", "T19"),
    ("bus_handler_sin_contexto", "44_event_bus.js",
     "  const ctx = { db: dbDeTenant(db, evento.tenant_id), tenantId: evento.tenant_id };",
     "  const ctx = { db, tenantId: evento.tenant_id };", "T19"),
    ("bus_consumo_no_registrado", "44_event_bus.js",
     "      await db.query(`INSERT INTO consumos_eventos (suscriptor, evento_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,\n        [nombreSuscriptor, evento.id]);",
     "", "T19"),
    ("bus_lease_sin_skip_locked", "44_event_bus.js",
     "                  ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)",
     "                  ORDER BY id LIMIT $1)", "T19"),
    ("cron_sin_ejecucion_unica", "server/workers/cronWorker.js",
     "    `INSERT INTO cron_ejecuciones (clave, tarea) VALUES ($1,$2) ON CONFLICT (clave) DO NOTHING RETURNING clave`,",
     "    `INSERT INTO cron_ejecuciones (clave, tarea) VALUES ($1 || ':' || gen_random_uuid(), $2) RETURNING clave`,", "T19"),
    ("morosos_sin_gracia", "migrations/006_workers_multiempresa.up.sql",
     "    AND s.current_period_end < now() - make_interval(days => greatest(0, least(coalesce(p_dias_gracia, 7), 90)))",
     "    AND s.current_period_end < now()", "T19"),
    ("agente_match_entre_empresas", "server/workers/agentWorker.js",
     "      if (!carga || !camion || carga.tenant_id !== camion.tenant_id) return null; // jamás entre empresas",
     "      if (!carga || !camion) return null;", "T19"),
    ("agente_sin_deduplicacion", "server/workers/agentWorker.js",
     "      if (!nuevo.rows.length) return null; // ya se le ofreció esta carga a este chofer",
     "", "T19"),
    ("agente_sin_guarda_de_lider", "server/workers/agentWorker.js",
     "      if (!esLider()) return [];",
     "", "T19"),
    ("notificacion_etiqueta_pisada", "45_notification_service.js",
     "    return { idioma: 'es', ...contacto, ...override, id: 'driver:' + driverId };",
     "    return { id: 'driver:' + driverId, idioma: 'es', ...rows[0], ...override };", "T19"),
    # E-040 — webhook de Stripe
    ("firma_stripe_no_verificada", "server/api/stripe_firma.js",
     "  if (!coincide) return { ok: false, motivo: 'firma_no_coincide' };",
     "", "T20"),
    ("firma_stripe_sin_tolerancia", "server/api/stripe_firma.js",
     "  if (Math.abs(ahora - c.t) > tolerancia) return { ok: false, motivo: 'fuera_de_tolerancia' };",
     "", "T20"),
    ("stripe_empresa_desde_metadata", "server/services/stripe_eventos.js",
     "    const tenantId = await empresaDelCliente(clienteId);",
     "    const meta = evento.data.object.metadata || {};\n    const tenantId = meta.tenant_id || await empresaDelCliente(clienteId);", "T20"),
    ("stripe_sin_deduplicacion", "server/services/stripe_eventos.js",
     "        if (ESTADOS_FINALES.has(rows[0].estado)) return { duplicado: true, resultado: rows[0].resultado };",
     "", "T20"),
    ("stripe_pago_sin_unicidad_por_factura", "migrations/007_facturacion_stripe.up.sql",
     "CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_factura_cobrada\n  ON payments (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL AND status = 'SUCCEEDED';",
     "", "T20"),
    ("stripe_estado_sin_orden", "03_billing_stripe.js",
     "    const posterior = fila.estadoEn === null || creado > fila.estadoEn",
     "    const posterior = true || fila.estadoEn === null || creado > fila.estadoEn", "T20"),
    ("stripe_empate_sin_prioridad_de_baja", "03_billing_stripe.js",
     "      || (creado === fila.estadoEn && estado === 'CANCELLED' && fila.status !== 'CANCELLED');",
     ";", "T20"),
    ("stripe_periodo_no_monotono", "03_billing_stripe.js",
     "          current_period_end = GREATEST(current_period_end, to_timestamp($6))",
     "          current_period_end = COALESCE(to_timestamp($6), current_period_end)", "T20"),
    ("stripe_ledger_fuera_de_transaccion", "03_billing_stripe.js",
     "        await this.ledger.asentar(client, {\n          tenantId, actor: ACTOR, accion: 'pago.registrado'",
     "        await this.ledger.registrar(this.db, {\n          tenantId, actor: ACTOR, accion: 'pago.registrado'", "T20"),
    ("stripe_fallo_no_registrado", "server/services/stripe_eventos.js",
     "      await registrarFallo(tenantId, evento, e);",
     "", "T20"),
    ("stripe_error_respondido_como_exito", "server/services/stripe_eventos.js",
     "      return { http: 500, cuerpo: { error: 'procesamiento_incompleto' } };",
     "      return { http: 200, cuerpo: { recibido: true } };", "T20"),
    ("stripe_cliente_desconocido_aceptado", "server/services/stripe_eventos.js",
     "        return { http: 503, cuerpo: { error: 'empresa_no_resuelta' } };",
     "        return { http: 200, cuerpo: { recibido: true } };", "T20"),
    ("stripe_pago_no_reactiva", "03_billing_stripe.js",
     "         WHERE id = $1 AND status IN ('TRIAL', 'SUSPENDED', 'CANCELLED', 'PAST_DUE')`, [tenantId]);",
     "         WHERE id = $1 AND status IN ('TRIAL')`, [tenantId]);", "T20"),
    # E-029 — auditoría de conformidad SQL
    # Módulo que ninguna prueba ejecuta (22): solo la auditoría SQL puede detectarlo.
    ("columna_inexistente_en_modulo_sin_pruebas", "22_reporte_irs.js",
     "                 AND b.status = 'DELIVERED'",
     "                 AND b.estado_entrega = 'DELIVERED'", "AUDITORIA"),
]


def copiar_arbol(destino: Path) -> None:
    archivos = subprocess.run(["git", "-C", str(RAIZ), "ls-files", "-z"], check=True,
                              capture_output=True).stdout.decode().split("\0")
    for rel in filter(None, archivos):
        origen = RAIZ / rel
        if origen.is_file():
            dst = destino / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(origen, dst)


def aplicar(destino: Path, archivo: str, patron, reemplazo: str) -> None:
    ruta = destino / archivo
    texto = ruta.read_text(encoding="utf-8")
    if patron is FIN:
        ruta.write_text(texto + "\n" + reemplazo + "\n", encoding="utf-8")
        return
    n = texto.count(patron)
    if n != 1:
        raise ValueError(f"patrón encontrado {n} veces en {archivo}")
    ruta.write_text(texto.replace(patron, reemplazo), encoding="utf-8")


def primera_falla(trabajo: Path) -> str:
    for log in ("t1_t7.log", "t8_t13.log", "t14_t16.log", "t17.log", "t18.log", "t19.log", "t20.log"):
        p = trabajo / log
        if p.exists():
            m = re.search(r"^FAIL (T\d+[a-z]?_\w+)", p.read_text(encoding="utf-8", errors="replace"), re.M)
            if m:
                return m.group(1)
    p = trabajo / "auditoria_sql.log"
    if p.exists():
        m = re.search(r"^ERRORES DE ESQUEMA: ([1-9]\d*)", p.read_text(encoding="utf-8", errors="replace"), re.M)
        if m:
            return f"AUDITORIA_SQL ({m.group(1)} errores de esquema)"
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--puerto", default="55436")
    ap.add_argument("--solo", nargs="*")
    ap.add_argument("--logs", help="directorio donde conservar los logs de cada mutación")
    args = ap.parse_args()
    seleccion = [m for m in MUTACIONES if not args.solo or m[0] in args.solo]
    sobreviven, invalidas, errores = [], [], []
    print(f"{'mutación':34} {'esperada':8} resultado")
    for nombre, archivo, patron, reemplazo, esperada in seleccion:
        with tempfile.TemporaryDirectory(prefix="mf-mut-") as tmp:
            os.chmod(tmp, 0o711)  # el usuario del servidor PostgreSQL debe poder atravesarlo
            arbol = Path(tmp) / "arbol"
            trabajo = Path(tmp) / "trabajo"
            copiar_arbol(arbol)
            try:
                aplicar(arbol, archivo, patron, reemplazo)
            except ValueError as e:
                invalidas.append(nombre)
                print(f"{nombre:34} {esperada:8} INVÁLIDA ({e})")
                continue
            env = dict(os.environ, PG_PORT=args.puerto)
            r = subprocess.run([str(arbol / "tests/integration/run_native_pg16.sh"), str(trabajo)],
                               env=env, capture_output=True, timeout=600)
            falla = primera_falla(trabajo)
            if r.returncode == 3:
                print(f"{nombre:34} {esperada:8} BLOCKED (entorno incompleto)")
                return 3
            if args.logs:
                dst = Path(args.logs) / nombre
                dst.mkdir(parents=True, exist_ok=True)
                for log in ("t1_t7.log", "t8_t13.log", "t14_t16.log", "t17.log", "t18.log", "t19.log", "t20.log", "auditoria_sql.log", "entorno.txt"):
                    if (trabajo / log).exists():
                        shutil.copy2(trabajo / log, dst / log)
            if r.returncode == 0:
                sobreviven.append(nombre)
                print(f"{nombre:34} {esperada:8} SOBREVIVE (todas las pruebas pasan)")
            elif falla:
                print(f"{nombre:34} {esperada:8} DETECTADA por {falla}")
            else:
                # exit != 0 sin ninguna prueba fallida: fallo del entorno, no evidencia de detección.
                errores.append(nombre)
                cola = (r.stdout + r.stderr).decode(errors="replace").strip().splitlines()[-3:]
                print(f"{nombre:34} {esperada:8} ERROR DE ENTORNO (exit {r.returncode}): {' | '.join(cola)}")
    total = len(seleccion) - len(invalidas) - len(errores)
    print(f"\nDETECTADAS {total - len(sobreviven)}/{total}; sobreviven={sobreviven or 'ninguna'}; "
          f"inválidas={invalidas or 'ninguna'}; errores de entorno={errores or 'ninguno'}")
    if errores:
        return 4
    if invalidas:
        return 2
    return 1 if sobreviven else 0


if __name__ == "__main__":
    sys.exit(main())
