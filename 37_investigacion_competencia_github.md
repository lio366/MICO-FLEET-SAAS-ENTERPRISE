# 37 — INVESTIGACIÓN DE COMPETENCIA (GitHub + mercado) — Noviembre 2026

Revisión de código abierto y del mercado para no quedarse atrás: qué tienen
los otros, qué copiamos y en qué los superamos.

## 1. Lo que encontramos en GitHub

| Proyecto | Qué es | Qué tenía y nosotros no | Estado |
|---|---|---|---|
| **suxrobGM/logistics-app** (LogisticsX, ~377k líneas) | TMS con despachador IA que espera aprobación humana | IFTA trimestral, importación CSV/XLSX, contraofertas automáticas, portal de cliente, HOS desde ELDs (Samsara/Motive/Geotab), tracking links compartibles, MCP server | Backend público; portales privados |
| **loadpartner/tms** (69 estrellas) | TMS open source para brokers | Flujo sms/email/ubicación/llamadas ya integrado; librería FMCSA SAFER en PHP | Pequeño, activo |
| **Fleetbase** (open source) | Plataforma logística modular | Tracking IoT, SDK modular | Muy técnico, sin IA |
| **fossabot/open-tms** | TMS en alpha | Nada usable aún | Alpha abandonado |
| **AscendTMS** (comercial, free tier) | TMS con plan gratis | Free-forever con 2 usuarios — competidor directo de precio | $69+/usuario/mes |
| **Active-Load-Map** (2019) | Mapa de cargas con clima/tráfico/husos horarios | La idea de overlays de clima en el mapa | Proyecto de internos |

## 2. Qué incorporamos YA de esa investigación (v5.1)

| Hallazgo | Dónde quedó |
|---|---|
| IFTA trimestral es función premium en todos — incluirlo gratis nos diferencia | `34_ifta_report.js` (nuevo) |
| APIs geográficas gratuitas verificadas (Nominatim, NWS, Open-Meteo, ORS) | `35_apis_gratuitas_geografia.js` (nuevo) |
| Importación CSV de choferes/cargas al registrarse | `36_onboarding_csv.js` (nuevo) |
| HOS/ELD: Samsara/Motive/Geotab leen las horas del chofer | Pendiente fase 2 (ver §4) |
| Tracking link para el shipper ver su carga en vivo | Pendiente fase 2 |
| MCP server (que Claude/Cursor manejen la flota) | Pendiente fase 2 |

## 3. En qué YA superamos a todos (diferenciadores reales)

1. **Bilingüe nativo ES/EN con IA negociando por teléfono** — nadie en open source tiene voz en español.
2. **App del chofer con modo sin internet (SMS "1"/"2")** — no encontrado en ningún repo.
3. **Multi-tenant SaaS a $99/mes** con aislamiento por base de datos.
4. **Score de confianza A-E automático** que bloquea sin humano.
5. **Verificación carrier en 4 capas** con evidencia física desde la app.
6. **Costo de infraestructura ~$6.50/mes** (Hetzner) vs cientos en SaaS comerciales.

## 4. Fase 2 (siguiente ronda, cuando se apruebe)

- **ELD/HOS:** leer horas de servicio del chofer desde Samsara/Motive/Geotab para que el agente no asigne cargas que violen HOS.
- **Tracking link del shipper:** URL pública sin login para que el cliente vea su carga en mapa vivo.
- **MCP server:** exponer la API a Claude/Cursor para que el broker maneje la flota con lenguaje natural.
- **Mapa con overlays:** clima + alertas + zonas horarias sobre las cargas (idea de Active-Load-Map, hoy trivial con los datos ya conectados en el archivo 35).
