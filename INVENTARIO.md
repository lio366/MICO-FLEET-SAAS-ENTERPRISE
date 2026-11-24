# Inventario verificable — commit f621fa3

Generado por `node tools/inventario.js --md docs/INVENTARIO.md` (2026-11-23T23:59:35.052Z). No editar a mano: regenerar.

Archivos versionados (sin evidencia histórica de `informes/`): **147**. Módulos JS: 65; alcanzables desde `server/index.js`: 33; cargados por pruebas PostgreSQL: 27. Contratos rotos: 4.

Conexión: *runtime* = alcanzable por `require` desde `server/index.js`; *bootstrap* = desde `scripts/migrate.js`; *solo pruebas* = únicamente lo cargan suites; *sin conexión* = nada lo carga. *texto* = la suite solo inspecciona su texto, no lo ejecuta.

| Ruta | Nº índice | Tipo | Líneas | SHA-256 (12) | Conexión | Prueba PG | Prueba unitaria | Contratos rotos |
|---|---|---|---|---|---|---|---|---|
| `.env.example` | — | config | 34 | `6c2b9ca9590e` | | | | |
| `.gitignore` | — | config | 16 | `06198ce2e5cd` | | | | |
| `00_README_MASTER.md` | 00 | documento | 296 | `7e092ce63f7b` | | | | |
| `01_multi_tenant_database.sql` | 01 | SQL | 200 | `d59ae2721ead` | | | | |
| `02_tenant_middleware.js` | 02 | código JS | 79 | `e835b0f70506` | runtime + PG | sí | no |  |
| `03_billing_stripe.js` | 03 | código JS | 397 | `a1912ece7c63` | runtime + PG | sí | sí |  |
| `04_cron_jobs.js` | 04 | código JS | 94 | `6477851b837f` | sin conexión | no | texto |  |
| `05_tenant_admin_api.js` | 05 | código JS | 123 | `80cf1c632434` | sin conexión | no | texto |  |
| `06_pricing_and_operations.md` | 06 | documento | 76 | `b3116323d0eb` | | | | |
| `07_ai_language_agent.js` | 07 | código JS | 140 | `69796de022d0` | runtime sin PG | no | texto |  |
| `08_auto_dispatch_agent.js` | 08 | código JS | 183 | `31a0902cc086` | runtime sin PG | no | no |  |
| `09_ejemplo_dia_broker.md` | 09 | documento | 33 | `673a80910a50` | | | | |
| `10_modo_100_automatico.md` | 10 | documento | 47 | `a1e56ab2e843` | | | | |
| `11_config_95_automatico.json` | 11 | datos/config | 43 | `913f32a740c1` | | | | |
| `12_precios_competitivos.md` | 12 | documento | 63 | `fc6878fc46ff` | | | | |
| `13_resultados_prueba_estres.md` | 13 | documento | 59 | `f3a6e26fb094` | | | | |
| `14_geospatial_engine.sql` | 14 | SQL | 89 | `8eae1097a9fb` | | | | |
| `15_neural_matching_engine.js` | 15 | código JS | 193 | `01382fdb0053` | runtime + PG | sí | sí |  |
| `16_entrega_carga_al_chofer.md` | 16 | documento | 81 | `744865bfb967` | | | | |
| `17_sms_emergencia.js` | 17 | código JS | 92 | `50be31cf28a5` | runtime + PG | sí | sí |  |
| `18_facturacion_quickbooks.js` | 18 | código JS | 98 | `748d624f59e6` | sin conexión | no | texto |  |
| `19_voz_ia_llamadas.js` | 19 | código JS | 93 | `2e8e851d4768` | sin conexión | no | texto | ./05_push_notifications.(archivo) (línea null) |
| `20_alerta_diesel.js` | 20 | código JS | 76 | `d1e62a4438c5` | solo pruebas | no | sí |  |
| `21_modo_familia.js` | 21 | código JS | 85 | `c4e31fb797c3` | sin conexión | no | texto |  |
| `22_reporte_irs.js` | 22 | código JS | 73 | `e3ead8726b2a` | sin conexión | no | texto |  |
| `23_pruebas_estres_completas.md` | 23 | documento | 79 | `b4a684934073` | | | | |
| `24_agentes_ia.md` | 24 | documento | 48 | `476af9eb7924` | | | | |
| `25_enrutador_modelos.js` | 25 | código JS | 138 | `d5068fb2b32d` | runtime sin PG | no | texto |  |
| `26_pruebas_estres_70.js` | 26 | código JS | 322 | `33675311ecf8` | sin conexión | no | no |  |
| `27_informe_70_pruebas.md` | 27 | documento | 42 | `be091369d9aa` | | | | |
| `28_camino2_broker_hibrido.md` | 28 | documento | 126 | `d72835aee081` | | | | |
| `29_match_tiempo_real.js` | 30 | código JS | 96 | `b581e06324c3` | runtime + PG | sí | sí |  |
| `30_tarifas_inteligentes.js` | 31 | código JS | 81 | `90d9305816d6` | solo pruebas | no | sí | 20_alerta_diesel.js.obtenerPrecioActual (línea 76) |
| `31_panel_semaforo.html` | 32 | HTML | 93 | `fb39301a3fde` | | | | |
| `32_score_confianza.js` | 33 | código JS | 95 | `a7e9b942eab6` | solo pruebas | no | sí |  |
| `33_verificacion_carrier.js` | 34 | código JS | 164 | `76f7847e44d2` | runtime + PG | sí | sí |  |
| `34_ifta_report.js` | 35 | código JS | 96 | `d453290a63d9` | solo pruebas | no | sí |  |
| `35_apis_gratuitas_geografia.js` | 36 | código JS | 132 | `25380e33587f` | solo pruebas | no | sí |  |
| `36_onboarding_csv.js` | 37 | código JS | 123 | `e5724e00e556` | solo pruebas | no | sí |  |
| `37_investigacion_competencia_github.md` | 38 | documento | 43 | `94e322470c0c` | | | | |
| `38_modo_voz_auricular.js` | 39 | código JS | 171 | `de31ae3c440a` | runtime + PG | sí | sí |  |
| `39_pruebas_sistema_completo.js` | 40 | código JS | 925 | `d62865a0827a` | sin conexión | no | no |  |
| `40_api_gateway.js` | 41 | código JS | 101 | `1d661652335c` | runtime sin PG | no | no |  |
| `41_auth_rbac.js` | 42 | código JS | 194 | `a798a6c815cd` | runtime + PG | sí | sí |  |
| `42_audit_ledger.js` | 43 | código JS | 580 | `8967c6728109` | runtime + PG | sí | sí |  |
| `43_metrics_observability.js` | 44 | código JS | 105 | `3c04ae7fd0b4` | runtime + PG | sí | sí |  |
| `44_event_bus.js` | 45 | código JS | 164 | `e9db5bc58024` | runtime + PG | sí | no |  |
| `45_notification_service.js` | 46 | código JS | 120 | `e1e1a9d07b18` | runtime + PG | sí | no |  |
| `46_distributed_lock.js` | 48 | código JS | 219 | `dcff7222150c` | runtime + PG | sí | sí |  |
| `47_scheduler_cluster.js` | 49 | código JS | 132 | `c1b910357b35` | runtime + PG | sí | sí |  |
| `48_deploy_stack.js` | 50 | código JS | 124 | `1662b71ba2c3` | sin conexión | no | no |  |
| `49_disaster_recovery.js` | 51 | código JS | 112 | `a17897aaf709` | sin conexión | no | no |  |
| `VERIFY.md` | — | documento | 88 | `c8c8c093f2e2` | | | | |
| `db/esquema.js` | — | código JS | 67 | `11a9f2a3ce01` | runtime + PG | sí | no |  |
| `db/migrador.js` | — | código JS | 109 | `8917cf1ade32` | runtime + PG | sí | sí |  |
| `db/sql.js` | — | código JS | 24 | `d8c8963bb7fb` | runtime + PG | sí | sí |  |
| `docker-compose.postgres.yml` | — | config | 34 | `d6294868d081` | | | | |
| `docs/BASELINE.md` | — | documento | 26 | `1747f8d5dbf3` | | | | |
| `docs/CONTRATOS.md` | — | documento | 51 | `09ddd0b6bc60` | | | | |
| `docs/DECISIONES.md` | — | documento | 117 | `f19b674b19f3` | | | | |
| `docs/ERRORES.md` | — | documento | 252 | `66d99954e87d` | | | | |
| `docs/MAPA_DEPENDENCIAS.md` | — | documento | 38 | `a372a7780308` | | | | |
| `docs/POSTGRESQL_REAL.md` | — | documento | 58 | `e713a035fa5f` | | | | |
| `docs/VERIFY.md` | — | documento | 88 | `c8c8c093f2e2` | | | | |
| `driver_app/App.js` | 29 | código JS | 406 | `ade5134e8fdc` | sin conexión | no | texto |  |
| `driver_app/LEEME_PRIMERO.md` | 29 | documento | 51 | `4ec8c6f55961` | | | | |
| `driver_app/app.json` | 29 | datos/config | 30 | `125fea2b5b7a` | | | | |
| `driver_app/package.json` | 29 | datos/config | 28 | `1ceca18ab2ff` | | | | |
| `driver_app/src/api.js` | 29 | código JS | 40 | `5c73db7e8345` | sin conexión | no | no |  |
| `driver_app/src/auricular.js` | 29 | código JS | 38 | `168e8308e082` | sin conexión | no | no |  |
| `driver_app/src/i18n.js` | 29 | código JS | 118 | `95c2c4e80bad` | sin conexión | no | texto |  |
| `driver_app/src/offline.js` | 29 | código JS | 95 | `d40ef1db7898` | sin conexión | no | texto |  |
| `informes/auditoria_correspondencia_20261123.md` | — | documento | 134 | `54f1efc10b06` | | | | |
| `informes/fase2_estado_ejecucion_20261123.md` | — | documento | 42 | `d57288cbfe8a` | | | | |
| `informes/fase2_evidencia_integracion.md` | — | documento | 41 | `c86bbbce0fe8` | | | | |
| `informes/fase2_pg_real_t1_t7_20261123.md` | — | documento | 99 | `fbf86d8ad27d` | | | | |
| `informes/fase2b_t8_t13_20261123.md` | — | documento | 103 | `b814bcdcf306` | | | | |
| `informes/fase2c_e016_e017_e022_20261123.md` | — | documento | 96 | `57dd8e586220` | | | | |
| `informes/fase2d_e025_webhooks_20261123.md` | — | documento | 72 | `61b0407029ba` | | | | |
| `informes/fase2e_api_rls_20261123.md` | — | documento | 89 | `547a1a7c0adc` | | | | |
| `informes/fase2f_workers_multiempresa_20261123.md` | — | documento | 96 | `1fec3fd2fde8` | | | | |
| `informes/fase2g_stripe_webhook_20261123.md` | — | documento | 46 | `37bba4faabeb` | | | | |
| `informes/fase3_ledger_v6_local_20261123.md` | — | documento | 33 | `91a2ce5eeb48` | | | | |
| `informes/fase4_evidencia_cluster_boot.md` | — | documento | 27 | `1241403cac0d` | | | | |
| `infra/postgres/001_roles.sql` | — | SQL | 24 | `4a0d95044826` | | | | |
| `infra/postgres/002_set_password.sh` | — | script shell | 11 | `28c888be4142` | | | | |
| `infra/postgres/003_app_grants.sql` | — | SQL | 56 | `fa6e6b5542a5` | | | | |
| `migrations/001_ledger_v6.down.sql` | — | SQL | 17 | `525383338c54` | | | | |
| `migrations/001_ledger_v6.up.sql` | — | SQL | 13 | `e562c3243504` | | | | |
| `migrations/002_operaciones_v7.down.sql` | — | SQL | 23 | `0226f7a376f5` | | | | |
| `migrations/002_operaciones_v7.up.sql` | — | SQL | 48 | `c1825a601f81` | | | | |
| `migrations/003_ledger_checkpoint_kid.down.sql` | — | SQL | 5 | `eecdc41c11ec` | | | | |
| `migrations/003_ledger_checkpoint_kid.up.sql` | — | SQL | 10 | `5378d3d856e9` | | | | |
| `migrations/004_resolucion_webhooks.down.sql` | — | SQL | 18 | `1d8723eed290` | | | | |
| `migrations/004_resolucion_webhooks.up.sql` | — | SQL | 68 | `9757bc31f021` | | | | |
| `migrations/005_api_autenticada.down.sql` | — | SQL | 18 | `c010f254ba3c` | | | | |
| `migrations/005_api_autenticada.up.sql` | — | SQL | 20 | `5ca683b3dfdc` | | | | |
| `migrations/006_workers_multiempresa.down.sql` | — | SQL | 42 | `38fa31c92102` | | | | |
| `migrations/006_workers_multiempresa.up.sql` | — | SQL | 127 | `f42e052e5801` | | | | |
| `migrations/007_facturacion_stripe.down.sql` | — | SQL | 21 | `7e79c3b6fcc2` | | | | |
| `migrations/007_facturacion_stripe.up.sql` | — | SQL | 61 | `b568c345be6e` | | | | |
| `migrations/README.md` | — | documento | 24 | `c08744921dc3` | | | | |
| `package.json` | — | datos/config | 48 | `d1d3c4c091c4` | | | | |
| `scripts/migrate.js` | — | código JS | 43 | `39a0ab1ba3af` | bootstrap | no | no |  |
| `scripts/verify.js` | — | código JS | 10 | `f62485da8b96` | sin conexión | no | no |  |
| `server/api/routes.js` | 47 | código JS | 138 | `4768db4b1ab4` | runtime + PG | sí | no |  |
| `server/api/stripe_firma.js` | 47 | código JS | 90 | `36b62f91ad58` | runtime + PG | sí | sí |  |
| `server/api/twilio_firma.js` | 47 | código JS | 66 | `9e6e41f27ef9` | runtime + PG | sí | sí |  |
| `server/api/webhooks.js` | 47 | código JS | 89 | `787dde20d450` | runtime + PG | sí | no |  |
| `server/http/contexto_tenant.js` | 47 | código JS | 126 | `ebefcc84e36a` | runtime + PG | sí | sí |  |
| `server/index.js` | 47 | código JS | 95 | `99f1bc446490` | runtime sin PG | no | no | 08_auto_dispatch_agent.js.(clase) (línea 55)<br>25_enrutador_modelos.js.(clase) (línea 59) |
| `server/services/README.md` | 47 | documento | 20 | `260d22c175f8` | | | | |
| `server/services/fmcsa_client.js` | 47 | código JS | 35 | `b28db6d0085c` | runtime + PG | sí | sí |  |
| `server/services/ofertas.js` | 47 | código JS | 114 | `f50259afc6a1` | runtime + PG | sí | sí |  |
| `server/services/stripe_eventos.js` | 47 | código JS | 117 | `150c7cfbb2e7` | runtime + PG | sí | no |  |
| `server/services/twilio_client.js` | 47 | código JS | 43 | `48ea172447b2` | sin conexión | no | no |  |
| `server/workers/agentWorker.js` | 47 | código JS | 120 | `c5beb19c336b` | runtime + PG | sí | sí |  |
| `server/workers/cronWorker.js` | 47 | código JS | 127 | `ae3cc30317da` | runtime + PG | sí | sí |  |
| `server/workers/eventWorker.js` | 47 | código JS | 21 | `e32e62185b9f` | runtime sin PG | no | no |  |
| `sql/02_tenant_middleware.sql` | — | SQL | 16 | `1c6d7bdafb5b` | | | | |
| `sql/03_billing_stripe.sql` | — | SQL | 25 | `e2d622f4dcfe` | | | | |
| `sql/30_tarifas_inteligentes.sql` | — | SQL | 14 | `347a6eab93b0` | | | | |
| `sql/32_score_confianza.sql` | — | SQL | 19 | `168dc08a6493` | | | | |
| `sql/33_verificacion_carrier.sql` | — | SQL | 34 | `6bbb52246d3b` | | | | |
| `sql/34_ifta_report.sql` | — | SQL | 20 | `42dad5af832a` | | | | |
| `sql/35_apis_gratuitas_geografia.sql` | — | SQL | 10 | `7102e1a10772` | | | | |
| `sql/41_auth_rbac.sql` | — | SQL | 33 | `0932a892bd23` | | | | |
| `sql/42_audit_ledger.sql` | — | SQL | 51 | `3baa871ea0cd` | | | | |
| `sql/42_audit_ledger_roles.sql` | — | SQL | 29 | `660ecc33f85e` | | | | |
| `sql/44_event_bus.sql` | — | SQL | 20 | `48c5d7fbb20e` | | | | |
| `sql/45_notification_service.sql` | — | SQL | 14 | `e0d9df1bf054` | | | | |
| `sql/47_scheduler_cluster.sql` | — | SQL | 8 | `7b3931aec56e` | | | | |
| `tests/integration/auditoria_sql.js` | — | código JS | 115 | `f1698507b08e` | sin conexión | no | no |  |
| `tests/integration/auditoria_sql_excepciones.json` | — | datos/config | 10 | `4c8ac8248d55` | | | | |
| `tests/integration/mutaciones_pg.py` | — | script Python | 312 | `2e61f6f8f42d` | | | | |
| `tests/integration/postgres_t14_t16.js` | — | código JS | 357 | `15e02289dbc6` | sin conexión | no | no |  |
| `tests/integration/postgres_t17.js` | — | código JS | 225 | `ccb01ba3794c` | sin conexión | no | no |  |
| `tests/integration/postgres_t18.js` | — | código JS | 260 | `1e78b8514655` | sin conexión | no | no |  |
| `tests/integration/postgres_t19.js` | — | código JS | 295 | `4c6fec9f625e` | sin conexión | no | no |  |
| `tests/integration/postgres_t1_t7.js` | — | código JS | 201 | `0e1fbc9a62ad` | sin conexión | no | no |  |
| `tests/integration/postgres_t20.js` | — | código JS | 292 | `a5d5eba8dcb4` | sin conexión | no | no |  |
| `tests/integration/postgres_t8_t13.js` | — | código JS | 488 | `c4464d574c7f` | sin conexión | no | no |  |
| `tests/integration/run_native_pg16.sh` | — | script shell | 150 | `f6392dbc6661` | | | | |
| `tools/inventario.js` | — | código JS | 261 | `74026e5ac874` | | | | |
| `tools/inventario_excepciones.json` | — | datos/config | 30 | `4dad15c3ea47` | | | | |
| `tools/pg-compat/README.md` | — | documento | 29 | `f65bb39b0b51` | | | | |
| `tools/pg-compat/index.js` | — | código JS | 737 | `f2b65231d118` | | | | |
