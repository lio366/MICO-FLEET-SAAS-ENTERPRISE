# INFORME — 70 PRUEBAS DE ESTRÉS AL SISTEMA COMPLETO
## Versión 3.9 · Resultado final: 70/70 PASADAS · 0 fallos
## Ejecutar de nuevo en cualquier momento: `node 26_pruebas_estres_70.js`

---

## RESUMEN POR GRUPO

| Grupo | Pruebas | Resultado | Qué se verificó |
|---|---|---|---|
| 1. API | 12/12 | ✅ | Validación de coordenadas (bug NaN de v1 corregido), rate limits por endpoint, conflicto 409 de carga activa, circuit breaker (abre a los 5 fallos), respaldo a Truckstop, caché dinámico por urgencia, caché como última red |
| 2. Stripe / cobros | 10/10 | ✅ | Precios de planes, prorrateo de upgrades, centavos vs dólares, webhook de pago exitoso, gracia de 7 días, bloqueo 402 por trial vencido, MRR, límites por plan, cancelación al fin de periodo, comisión 2.9% |
| 3. Seguridad | 12/12 | ✅ | Contraseñas con hash (nunca texto plano), tokens que no se pueden alterar, aislamiento RLS en las 3 tablas críticas, solo ADMIN crea usuarios y marca, expiración de sesión, CASCADE al borrar tenant, índices parciales, webhook firmado |
| 4. App del chofer | 12/12 | ✅ | Paridad ES/EN (ninguna pantalla rota en ningún idioma), botón ACEPTAR, cola offline FIFO, máximo 3 fotos, SMS 1/2/otro, GPS cada 10 min, navegación con dirección, idioma guardado, reconexión automática, rechazo con motivo, notificaciones |
| 5. Panel del broker | 12/12 | ✅ | Límites de plan (6º camión bloqueado en Solo), reportes por camión, RPM, branding white-label, 402 en mora, historial de pagos, cron de suspensiones, avisos de trial, portero por subdominio/dominio, cambio de plan |
| 6. Estructura web | 12/12 | ✅ | Los 20 archivos críticos existen, búsqueda espacial con radio, índices GIST, red neuronal de 18 señales, reentrenamiento a las 30 muestras, enrutador Ollama→OpenRouter→OpenAI, voz en vivo, diésel, modo familia, IRS 20%, QuickBooks |

## HALLAZGOS DURANTE LA EJECUCIÓN (y su corrección)

| # | Hallazgo | Gravedad | Fix |
|---|---|---|---|
| 1 | La prueba T35 detectó una clave extra ('en') contaminando la comparación de idiomas | Baja (era de la prueba, no del sistema) | Corregida la extracción de claves; paridad ES/EN confirmada real |
| 2 | La prueba T47 detectó la lógica de límite de plan ambigua en la prueba: con 5 camiones en plan Solo no quedaba claro si el 6º se bloquea | Media (semántica del endpoint) | Confirmada la regla definitiva: con 5 activos, el 6º se bloquea; con 4, entra. Test endurecido con 4 casos |

## COBERTURA DE LA CADENA COMPLETA

```
T1–T12   API: oferta → validación → límite → circuit breaker → caché
T13–T22  STRIPE: plan → cobro → webhook → mora → suspensión
T23–T34  SEGURIDAD: contraseña → token → aislamiento → roles → expiración
T35–T46  APP CHOFER: idioma → notificación → offline → SMS → fotos → GPS
T47–T58  PANEL BROKER: límites → reportes → branding → facturación
T59–T70  ESTRUCTURA: archivos → espacial → neuronal → enrutador → voz → diésel → familia → IRS → QuickBooks
```

## NOTA HONESTA
Estas 70 pruebas verifican la **lógica, reglas y estructura** de todo el sistema
(la capa del cerebro). Las pruebas que requieren el servidor montado con llaves
reales —conexión viva a DAT, cobro real de Stripe, llamada telefónica con voz—
se corren en la Fase 1 del montaje (ver archivo 00, PASO 6). La suite está
diseñada para correrse de nuevo en ese momento: `node 26_pruebas_estres_70.js`.
