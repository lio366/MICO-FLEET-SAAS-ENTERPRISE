/**
 * MODO SIN INTERNET — La app del chofer NO se detiene sin señal
 *
 * EL PROBLEMA: el chofer pasa por ranchos, desiertos y carreteras
 * donde no hay datos. Sin conexión, una app normal se queda ciega.
 *
 * LA SOLUCIÓN (3 capas):
 *   1. OFFLINE LOCAL — lo que ya tiene guardado se sigue viendo sin internet:
 *      la carga asignada, direcciones, navegación (Google Maps guarda el mapa).
 *   2. COLA DE ACCIONES — todo lo que toca el chofer se guarda en el teléfono
 *      y se envía SOLO cuando vuelve la señal: aceptar, rechazar, fotos, GPS.
 *   3. SMS DE EMERGENCIA — si hay UNA RAYITA de señal (voz/SMS funciona aunque
 *      los datos no), los mensajes críticos salen por SMS al servidor
 *      a través de un número corto: aceptar una carga = responder "1".
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import api from './api';

const COLA = 'cola_offline';          // acciones esperando señal
const CARGA_LOCAL = 'carga_activa';   // carga guardada para ver sin internet

// ── CAPA 1: ver la carga sin internet ──
export async function guardarCargaLocal(carga) {
    await AsyncStorage.setItem(CARGA_LOCAL, JSON.stringify(carga));
}
export async function leerCargaLocal() {
    const data = await AsyncStorage.getItem(CARGA_LOCAL);
    return data ? JSON.parse(data) : null;
}

// ── CAPA 2: cola de acciones (funciona sin señal, envía solo) ──
export async function encolarAccion(accion) {
    // accion = { tipo: 'aceptar'|'rechazar'|'fotos'|'gps', datos: {...} }
    const cola = JSON.parse(await AsyncStorage.getItem(COLA) || '[]');
    cola.push({ ...accion, cuando: new Date().toISOString() });
    await AsyncStorage.setItem(COLA, JSON.stringify(cola));
    intentarSincronizar(); // si hay señal ahora, sale de inmediato
}

// Intenta vaciar la cola. Se llama solo: al volver la señal y al abrir la app.
export async function intentarSincronizar() {
    const red = await NetInfo.fetch();
    if (!red.isConnected) return; // sin señal: queda guardado, no se pierde nada

    const cola = JSON.parse(await AsyncStorage.getItem(COLA) || '[]');
    if (!cola.length) return;

    const restantes = [];
    for (const item of cola) {
        try {
            await ejecutar(item);      // llegó al servidor
        } catch (e) {
            restantes.push(item);      // falló: se queda en la cola para el próximo intento
        }
    }
    await AsyncStorage.setItem(COLA, JSON.stringify(restantes));
}

async function ejecutar(item) {
    switch (item.tipo) {
        case 'aceptar':  return api.acceptLoad(item.datos.loadId);
        case 'rechazar': return api.rejectLoad(item.datos.loadId, item.datos.razon);
        case 'pickup':   return api.confirmPickup(item.datos.bookingId, item.datos.photos);
        case 'delivery': return api.confirmDelivery(item.datos.bookingId, item.datos.photos);
        case 'gps':      return api.sendPosition(item.datos.lat, item.datos.lng,
                                                 item.datos.speed, item.datos.heading);
    }
}

// Vigila la señal: en cuanto vuelve, vacía la cola sola
export function vigilarSenal() {
    NetInfo.addEventListener(state => {
        if (state.isConnected) intentarSincronizar();
    });
    // Y cada 5 minutos por si acaso
    setInterval(intentarSincronizar, 5 * 60 * 1000);
}

// ── CAPA 3: SMS de emergencia (una rayita de señal basta) ──
// Si el servidor no recibe confirmación en 15 min, manda SMS al chofer:
//   "Carga #4521 Miami→Atlanta $1,950. Responde 1 para aceptar, 2 para rechazar"
// El chofer responde "1" y Twilio lo recibe como webhook aunque la app esté cerrada
// y sin datos. Aceptación garantizada con la señal mínima del plan celular.
export const SMS_EMERGENCIA = {
    activo: true,
    // Número de Twilio del sistema: se configura UNA vez en app.json (extra.twilioNumero)
    // y la app lo lee sola. Nunca dejar el placeholder en producción.
    numeroCorto: (Constants.expoConfig?.extra?.twilioNumero) || '+1-000-000-0000',
    comoFunciona:
        'Sin datos móviles, el SMS sí entra. Responder "1" acepta la carga; ' +
        'el servidor lo registra igual que un toque en la app.'
};
