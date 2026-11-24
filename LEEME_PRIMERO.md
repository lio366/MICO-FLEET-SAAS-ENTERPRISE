# APP DEL CHOFER — Cómo publicarla en Google Play y App Store

## QUÉ ES
La aplicación que el chofer instala en su teléfono. Todo en español.
4 pantallas: Login → Carga ofrecida (botón ACEPTAR) → Carga en curso → Cámara (fotos).

## CÓMO COMPILARLA (sin ser programador)
1. Crear cuenta gratis en https://expo.dev
2. Instalar Node.js en tu computadora
3. En la terminal, dentro de esta carpeta:
   ```
   npm install
   npm install -g eas-cli
   eas login
   eas build --platform android     → genera el archivo .apk/.aab
   eas build --platform ios         → genera el archivo para iPhone
   ```
4. Subir el archivo a Google Play Console ($25 una vez, de por vida) y Apple Developer ($99/año)
5. En 2-7 días está publicada y el chofer la busca por nombre

## LO ÚNICO QUE HAY QUE EDITAR
En `app.json`, cambia:
```
"apiUrl": "https://TU-SERVIDOR.com"
```
por la dirección real del servidor (el que arranca `server/index.js` con `npm start`).

## QUÉ NECESITA EL SERVIDOR PARA QUE LA APP FUNCIONE
Estos endpoints **todavía no existen en el servidor** (E-042 en `docs/ERRORES.md`: el archivo `03_driver_app_api.js` citado en versiones anteriores no está en el repositorio y `server/api/routes.js` no define rutas `/api/driver/*`). Son el contrato que la app espera:
```
POST /api/driver/login                  → teléfono + contraseña
GET  /api/driver/loads/pending          → la carga ofrecida ahora
POST /api/driver/loads/:id/accept       → el botón ACEPTAR
POST /api/driver/bookings/:id/pickup    → fotos de recogida
POST /api/driver/bookings/:id/delivery  → fotos de entrega + dispara la factura
POST /api/driver/position               → GPS cada 10 min
```

## COSTOS DE PUBLICAR
| Concepto | Costo |
|---|---|
| Google Play (Android) | $25 una vez, para siempre |
| Apple App Store | $99/año |
| Expo (compilación) | Gratis |
| **Total primer año** | **$124** |

## PARA EL CHOFER
- Teléfono Android o iPhone normal
- Datos móviles (la app usa pocos MB: texto + fotos comprimidas)
- Sin saber inglés: todo llega en español
