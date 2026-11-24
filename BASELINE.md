# Baseline de fuente — Micro Fleet SaaS Enterprise

**Estado:** snapshot de fuente importada; no equivale a certificación ni a despliegue.

## Procedencia

- Archivo recibido: `OKComputer_APP_CAMIONES_.zip`
- SHA-256 del ZIP recibido: `80b05f2e3841cc8e0d097775b92576d424f358d05f3bc14cb95ac18373d9d66c`
- Directorio de producto seleccionado dentro del ZIP: `micro_fleet_saas_enterprise/`
- Inventario de esa carpeta: 74 archivos, 396.583 bytes en el momento del snapshot.
- Incluye 47 archivos JavaScript, 2 SQL y 21 Markdown, además de JSON/HTML y la app móvil.
- El ZIP recibido también contiene `review/micro_fleet_saas_enterprise/` y un ZIP anidado. No se mezclaron en el árbol principal: son material de revisión/paquetes paralelos y deben compararse por separado antes de integrar.

## Hallazgos estructurales verificados

1. El árbol principal contiene módulos numerados `01`–`49`, `server/`, `driver_app/`, `docs/` e `informes/`.
2. No existe `package.json` ni `package-lock.json` en la raíz del backend. El único `package.json` encontrado pertenece a `driver_app/`. _(Superado en `7088099`: existe `package.json` raíz; sigue faltando `package-lock.json`, por lo que `npm ci` no es posible.)_
3. No existe directorio `test/` o `tests/` en el árbol principal. `39_pruebas_sistema_completo.js` y `26_pruebas_estres_70.js` son scripts de prueba ubicados en la raíz.
4. `server/index.js` carga `dotenv`, `pg`, `stripe` y módulos locales; el paquete no declara las dependencias del servidor en un manifiesto raíz. Esto explica que `require('dotenv')` falle cuando no está instalado en el entorno de ejecución.
5. `42_audit_ledger.js` declara `SERIALIZATION_VERSION = 'rfc8785'`, `SQL_ROLES`, `MIGRACIONES`, migración/reversión, bloqueo `LOCK TABLE ... IN SHARE MODE`, resolución de COMMIT ambiguo y firma dual HMAC/Ed25519. La presencia del código no demuestra por sí sola conformidad RFC 8785, aplicación real de roles/migraciones ni validación criptográfica; eso queda sujeto a pruebas reproducibles.
6. Los informes `informes/fase2_evidencia_integracion.md` y `informes/fase4_evidencia_cluster_boot.md` son evidencia preexistente incluida en el ZIP. Se preservan como registros del paquete, pero no se atribuyen a esta sesión ni se consideran re-ejecutados.

## Alcance del snapshot Git

El repositorio Git inicializa sobre el árbol de producto seleccionado. No se incorpora el ZIP contenedor completo, secretos, `node_modules` ni el material paralelo de `review/`. El ZIP original debe conservarse sin cambios como fuente de procedencia.
