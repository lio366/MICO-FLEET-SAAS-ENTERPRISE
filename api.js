/**
 * CONEXIÓN CON EL SERVIDOR — Lo único que hay que tocar
 * Cambia TU-SERVIDOR.com por la dirección real cuando el servidor esté montado.
 */
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const API_URL = Constants.expoConfig.extra.apiUrl;

const api = axios.create({ baseURL: `${API_URL}/api/driver` });

// Envía el token de login en cada llamada automáticamente
api.interceptors.request.use(async (config) => {
    const token = await AsyncStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
});

export default {
    // ── AUTENTICACIÓN ──
    login: (phone, password) => api.post('/login', { phone, password }),

    // ── CARGAS ──
    getPendingLoad: () => api.get('/loads/pending'),           // carga ofrecida ahora
    getActiveLoad: () => api.get('/loads/active'),             // carga en curso
    acceptLoad: (loadId) => api.post(`/loads/${loadId}/accept`),
    rejectLoad: (loadId, reason) => api.post(`/loads/${loadId}/reject`, { reason }),

    // ── ESTADOS CON FOTOS ──
    confirmPickup: (bookingId, photos) =>
        api.post(`/bookings/${bookingId}/pickup`, { photos }), // fotos en base64
    confirmDelivery: (bookingId, photos) =>
        api.post(`/bookings/${bookingId}/delivery`, { photos }),

    // ── UBICACIÓN GPS (cada 10 min) ──
    sendPosition: (lat, lng, speed, heading) =>
        api.post('/position', { lat, lng, speed, heading, timestamp: new Date().toISOString() })
};
