# Fase 2e: API autenticada con RLS por petición y auditoría SQL (E-028 a E-034)

**Fecha de ejecución:** 2026-11-23 (18:00–18:50 UTC)
**Commit evaluado:** `98597a4` (rama `fase2/pg-real-t1-t7`), árbol limpio
**Evidencia:** `informes/evidencia_fase2e_api_rls_20261123/` (hashes en `SHA256SUMS`)

## Veredicto

| Gate | Estado |
|---|---|
| T1–T7 · T8–T13 · T14–T16 · T17 · T18 | PASS 7/7 · 6/6 · 3/3 · 1/1 · 1/1 (pg-compat), 3 de 3 corridas limpias en `98597a4` |
| Auditoría de conformidad SQL ↔ esquema | PASS: 0 errores nuevos; 5 hallazgos cubiertos por 4 excepciones documentadas (de 26 hallazgos iniciales) |
| Mutaciones de integración | 35/35 detectadas (`mutaciones_pg.py`, exit 0) |
| Suites 26 / 39 | 70/70 · 81/81 |
| `node --check` | 62 archivos, 0 errores |
| RLS por petición en la API autenticada (E-028) | **PASS (pg-compat, proveedores criptográficos de prueba)** |
| Enrutado Express, `bcryptjs` y `jsonwebtoken` reales | NOT RUN (sin `npm ci`) |
| Workers multiempresa bajo RLS (E-031) | **FAIL por análisis**, abierto |
| PostGIS: módulos 14 y 34 (E-032) | BLOCKED: extensión no disponible en el entorno |

## E-028: la API autenticada no podía arrancar ni aislar empresas

Defectos encontrados al recorrer el camino `/api`:

1. **No arrancaba.** `server/index.js` pasaba al gateway la **clase** `TenantMiddleware`, no una instancia. `tenantMiddleware.identifyTenant` era `undefined` y `app.use(undefined)` aborta el arranque. Además, el middleware exigía Redis, que el proyecto descartó.
2. **Login y sesión imposibles bajo RLS.** `users` y `sesiones` tienen RLS forzado, y `login` y `requireAuth` consultaban sin contexto de empresa: 0 filas, así que todo login daba 401.
3. **Vulnerabilidad de aislamiento: un token de otra empresa era aceptado.** `requireAuth` no comprobaba que el tenant del token coincidiera con el del Host. Como las rutas usan `req.tenant.id`, un usuario legítimo de A podía leer y modificar los datos de B con su propio token. Es el defecto más grave de la fase.
4. **Fuga de contexto.** `setTenantContext` usaba `set_config(..., false)` sobre el pool: el contexto se quedaba pegado a una conexión cualquiera y la heredaba otra petición (ni siquiera estaba montado).
5. **Bloqueo por fuerza bruta frágil.** Los intentos fallidos se escribían en la misma secuencia que el login fallido.
6. **Rutas contra un esquema inexistente:** `drivers.status`, `mc_number`, `truck_name`, `bookings.rate`, `bookings.created_at`, tabla `aprobaciones`. Además, `33.veredictoVerificacion` seleccionaba `d.nombre, d.apellido` y sus dos `UPDATE` reservaban un `$3` sin usar que PostgreSQL no puede tipar, **así que fallaban siempre**. `GET /loads` no exigía permiso.

**Corrección:**
- **`server/http/contexto_tenant.js`:**
  - resolución de empresa por Host (subdominio de `APP_BASE_DOMAIN` o dominio propio) con caché en memoria y TTL;
  - `req.enTenant(fn)`: cada acceso a datos en una transacción con `app.current_tenant` **local**, de modo que la conexión vuelve limpia al pool.
- **`02` v7.2:** métodos enlazados, sin Redis; el límite de plan se cuenta dentro del contexto (antes, bajo RLS, contaba 0 y nunca se aplicaba).
- **`41` v7.2:**
  - `users` y `sesiones` se consultan dentro del contexto;
  - **el tenant del token debe ser el del Host (si no, 403)**;
  - el rol vigente es el de la sesión en BD;
  - los intentos fallidos se guardan en su propia transacción;
  - JWT fijado a HS256 y `JWT_SECRET` de al menos 32 caracteres (falla cerrado);
  - `bcryptjs` y `jsonwebtoken` se cargan de forma perezosa e inyectable.
- **`routes.js`:** definiciones puras más cableado Express; todo pasa por `req.enTenant` con columnas reales; nuevo permiso `loads:read`; **el evento del outbox se escribe en la misma transacción que la asignación** (gancho `alAsignar` de 46); aprobaciones responde 501 (E-033).
- **Migración 005:** `drivers.status`, `mc_number` y `notes`; `loads.delivery_at`; índice único en `sesiones.token_hash`.

**T18** recorre la cadena del gateway con dos empresas y un pool de **4 conexiones**:
- **Host:** subdominio en mayúsculas con puerto, dominio propio, empresa desconocida, host con sufijo hostil, empresa suspendida y trial vencido;
- **login aislado:** el usuario de B no existe en A; tras 5 fallos, la contraseña correcta queda bloqueada;
- **token de A en el host de B: 403**; `tid` manipulado y `alg=none`: 401;
- permisos y límite de plan; un error de BD hace rollback sin datos parciales;
- asignación con evento en el outbox; chofer no verificado o de otra empresa: 403;
- **40 peticiones concurrentes alternando empresas, sin un solo cruce de datos**;
- **ninguna conexión del pool conserva contexto** tras las peticiones;
- el logout revoca la sesión.

**Límites de T18:** usa proveedores criptográficos de prueba (scrypt y HS256 con `node:crypto`), porque `bcryptjs` y `jsonwebtoken` no están instalados, y no ejecuta el enrutado ni los parsers de Express. Lo que valida es la lógica propia del proyecto.

## E-029: auditoría de conformidad SQL ↔ esquema

`tests/integration/auditoria_sql.js` extrae cada SQL literal pasado a `.query()` en el código de la aplicación y lo analiza con `PREPARE` contra el esquema real. Así resuelve tablas, columnas, funciones y tipos de parámetros sin ejecutar nada. Nota: la primera versión de la herramienta no liberaba las sentencias preparadas (son de sesión, no transaccionales); se corrigió con `DEALLOCATE ALL` antes de contar resultados.

| Momento | DML auditadas | Errores de esquema |
|---|---|---|
| Inicial (`ba03a17`) | 153 | **26 en 11 archivos** (16 tablas inexistentes, 10 columnas inexistentes) y 2 parámetros sin tipo |
| Tras añadir el DDL de los módulos 30, 32, 33 y 35 a la secuencia | 153 | 16 en 8 archivos |
| Final (`98597a4`) | 150 | **0 nuevos**; 5 cubiertos por 4 excepciones documentadas |

Las tablas de los módulos 30, 32, 33 y 35 tenían DDL propio que **ninguna secuencia de arranque aplicaba** (la misma clase de defecto que E-020). Los módulos 14 y 34 requieren PostGIS (E-032).

El gate falla si aparece un hallazgo nuevo **o si una excepción queda obsoleta**. La mutación `columna_inexistente_en_modulo_sin_pruebas` demuestra que la auditoría detecta por sí sola una columna inexistente en un módulo que ninguna prueba ejecuta.

## Otros defectos registrados

- **E-030 (corregido en el worker):** `subscriptions` se define dos veces (`01` y `03`) con columnas distintas. `CREATE TABLE IF NOT EXISTS` hace que gane la primera, así que `estado`, `grace_termina` y `stripe_subscription_id` de `03` nunca existen. `cronWorker` usaba esas columnas. Ahora usa las reales y la regla documentada (7 días de gracia) y suspende la empresa en `tenants.status`, que es lo que comprueba el gateway. También tenía mal el formato de las notificaciones.
- **E-031 (abierto, FAIL por análisis):** los workers (`cronWorker`, `agentWorker`, el bus de eventos 44) recorren todas las empresas con el rol runtime. Bajo RLS forzado no ven filas sin contexto. Requiere una identidad de mantenimiento de mínimo privilegio, o iterar por empresa con `enTenant`.
- **E-032 (BLOCKED):** `14_geospatial_engine.sql` y `34_ifta_report` requieren PostGIS, que no está disponible en este entorno; están fuera de la secuencia de esquema.
- **E-033 (abierto):** el "SÍ" humano del modo 95 % no tiene esquema ni productor de aprobaciones; la ruta responde 501.
- **E-034 (abierto):** `04_cron_jobs.js` es un planificador antiguo que no está conectado en ningún sitio (consulta `tenants.email`, que no existe). Retirarlo requiere ajustar tres comprobaciones textuales de la suite 26.

## Mutaciones: 35/35

Siete nuevas, detectadas por T18 o por la auditoría: token de otra empresa aceptado, contexto de sesión en el pool, intentos fallidos no registrados, límite de plan fuera de contexto, ruta que consulta sin contexto, sesión revocada aceptada y columna inexistente en un módulo sin pruebas.

## Configuración nueva

- `APP_BASE_DOMAIN`: dominio base de los subdominios de empresa (por defecto `tuapp.com`).
- `JWT_SECRET`: obligatorio y de al menos 32 caracteres.
