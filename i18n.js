/**
 * IDIOMAS DE LA APP DEL CHOFER — El chofer escoge EN o ES al entrar.
 * Se guarda su elección y no vuelve a preguntar.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const TEXTOS = {
    es: {
        // Login
        appSub: 'App del Conductor',
        telefono: 'Teléfono',
        contrasena: 'Contraseña',
        entrar: 'ENTRAR',
        errorLogin: 'Teléfono o contraseña incorrectos',
        elegirIdioma: 'Language / Idioma:',

        // Esperando carga
        buscando: '🔍 Buscando cargas para ti...',
        avisoEspera: 'Te avisamos en cuanto haya una buena.\nPuedes cerrar la app.',

        // Oferta de carga
        nuevaCarga: '🔔 NUEVA CARGA',
        millas: 'millas',
        aceptar: '✅ ACEPTAR',
        rechazar: '✖ RECHAZAR',
        rechazarPorque: '¿Por qué la rechazas? (la IA aprende para no ofrecerte así)',
        motivoPrecio: 'Precio bajo',
        motivoZona: 'Zona/lejos',
        motivoHorario: 'Horario',
        cancelar: 'Cancelar',
        yaTomada: 'Esta carga ya fue tomada. Esperando otra...',
        sinSenalAceptar: 'Sin señal ahora. Tu aceptación quedó guardada y se envía sola cuando vuelva la conexión.',

        // En curso
        etapaRecoger: '📋 ACEPTADA — ve a recoger',
        etapaCamino: '🚛 EN CAMINO a entrega',
        etapaEntregada: '✅ ¡ENTREGADA!',
        recogerEn: '📍 Recoger:',
        entregarEn: '📍 Entregar:',
        navegarRecogida: '🧭 NAVEGAR A RECOGIDA',
        navegarEntrega: '🧭 NAVEGAR A ENTREGA',
        llegue: '📸 LLEGÉ — TOMAR FOTOS',
        entregue: '📸 ENTREGUÉ — TOMAR FOTOS',
        entregadaTitulo: '🎉 ¡Carga completada!',
        entregadaHint: 'El broker ya fue avisado y la factura se envió sola.\nBuscaremos tu próxima carga.',
        buscarOtra: 'BUSCAR OTRA CARGA',

        // Cámara
        fotosRecogida: '📸 Fotos de RECOGIDA',
        fotosEntrega: '📸 Fotos de ENTREGA',
        guiaFotos: 'Foto 1: papel firmado · Foto 2: mercancía · Foto 3: extra',
        tomar: '📷 TOMAR',
        enviar: '⬆ ENVIAR',
        permisoCamara: 'Necesitamos permiso de cámara',
        errorFotos: 'No se pudieron subir las fotos. Inténtalo de nuevo.'
    },

    en: {
        // Login
        appSub: 'Driver App',
        telefono: 'Phone',
        contrasena: 'Password',
        entrar: 'SIGN IN',
        errorLogin: 'Wrong phone or password',
        elegirIdioma: 'Language / Idioma:',

        // Esperando carga
        buscando: '🔍 Looking for loads for you...',
        avisoEspera: "We'll notify you when a good one appears.\nYou can close the app.",

        // Oferta de carga
        nuevaCarga: '🔔 NEW LOAD',
        millas: 'miles',
        aceptar: '✅ ACCEPT',
        rechazar: '✖ REJECT',
        rechazarPorque: 'Why are you rejecting? (the AI learns not to offer these)',
        motivoPrecio: 'Low rate',
        motivoZona: 'Area/too far',
        motivoHorario: 'Schedule',
        cancelar: 'Cancel',
        yaTomada: 'This load was already taken. Waiting for another...',
        sinSenalAceptar: 'No signal right now. Your acceptance is saved and will send itself when connection returns.',

        // En curso
        etapaRecoger: '📋 ACCEPTED — go pick up',
        etapaCamino: '🚛 EN ROUTE to delivery',
        etapaEntregada: '✅ DELIVERED!',
        recogerEn: '📍 Pick up:',
        entregarEn: '📍 Deliver:',
        navegarRecogida: '🧭 NAVIGATE TO PICKUP',
        navegarEntrega: '🧭 NAVIGATE TO DELIVERY',
        llegue: '📸 ARRIVED — TAKE PHOTOS',
        entregue: '📸 DELIVERED — TAKE PHOTOS',
        entregadaTitulo: '🎉 Load completed!',
        entregadaHint: 'The broker was notified and the invoice was sent automatically.\nWe will find your next load.',
        buscarOtra: 'FIND ANOTHER LOAD',

        // Cámara
        fotosRecogida: '📸 Pickup PHOTOS',
        fotosEntrega: '📸 Delivery PHOTOS',
        guiaFotos: 'Photo 1: signed paper · Photo 2: freight · Photo 3: extra',
        tomar: '📷 TAKE',
        enviar: '⬆ SEND',
        permisoCamara: 'We need camera permission',
        errorFotos: 'Could not upload photos. Please try again.'
    }
};

// Carga el idioma guardado (por defecto español)
export async function cargarIdioma() {
    const guardado = await AsyncStorage.getItem('idioma');
    return guardado || 'es';
}

export async function guardarIdioma(lang) {
    await AsyncStorage.setItem('idioma', lang);
}
