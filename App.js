/**
 * APP DEL CHOFER — Micro-Fleet
 * EL CHOFER ESCOGE SU IDIOMA al entrar: English o Español.
 * Todo el texto de la app cambia al idioma elegido, se guarda y no vuelve a preguntar.
 * Flujo: Login → Ver carga ofrecida → ACEPTAR → Recoger (fotos) → Entregar (fotos) → Lista para otra
 */
import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet, TextInput,
    Alert, ScrollView, Linking, ActivityIndicator
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import { Camera } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from './src/api';
import { TEXTOS, cargarIdioma, guardarIdioma } from './src/i18n';
import { encolarAccion, intentarSincronizar, vigilarSenal,
         guardarCargaLocal, leerCargaLocal } from './src/offline';
import NetInfo from '@react-native-community/netinfo';

const Stack = createNativeStackNavigator();
const AZUL = '#3B82F6', VERDE = '#10B981', ROJO = '#EF4444', OSCURO = '#0F172A';

// Contexto de idioma: cualquier pantalla puede usar t('aceptar')
const LangContext = createContext({ lang: 'es', setLang: () => {}, t: (k) => TEXTOS.es[k] || k });
const useLang = () => useContext(LangContext);

// La notificación abre la app directo en la carga
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true
    })
});

// ═══════════════ PANTALLA 1: LOGIN (con selector de idioma) ═══════════════
function LoginScreen({ navigation }) {
    const { lang, setLang, t } = useLang();
    const [phone, setPhone] = useState('');
    const [password, setPassword] = useState('');
    const [cargando, setCargando] = useState(false);

    const cambiarIdioma = async (nuevo) => {
        setLang(nuevo);
        await guardarIdioma(nuevo);   // se guarda: no vuelve a preguntar
    };

    const entrar = async () => {
        setCargando(true);
        try {
            const res = await api.login(phone, password);
            await AsyncStorage.setItem('token', res.data.token);
            await registrarGPSyNotificaciones();
            navigation.replace('Inicio');
        } catch (e) {
            Alert.alert('Error', t('errorLogin'));
        }
        setCargando(false);
    };

    return (
        <View style={estilos.login}>
            <Text style={estilos.logo}>🚛 Micro-Fleet</Text>

            {/* SELECTOR DE IDIOMA: el chofer escoge la suya */}
            <Text style={estilos.selectorEtiqueta}>{t('elegirIdioma')}</Text>
            <View style={estilos.selectorFila}>
                <TouchableOpacity
                    style={[estilos.selectorBoton, lang === 'es' && estilos.selectorActivo]}
                    onPress={() => cambiarIdioma('es')}>
                    <Text style={estilos.selectorTexto}>🇪🇸 Español</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[estilos.selectorBoton, lang === 'en' && estilos.selectorActivo]}
                    onPress={() => cambiarIdioma('en')}>
                    <Text style={estilos.selectorTexto}>🇺🇸 English</Text>
                </TouchableOpacity>
            </View>

            <Text style={estilos.subtitulo}>{t('appSub')}</Text>
            <TextInput style={estilos.input} placeholder={t('telefono')}
                placeholderTextColor="#64748B"
                keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
            <TextInput style={estilos.input} placeholder={t('contrasena')}
                placeholderTextColor="#64748B" secureTextEntry
                value={password} onChangeText={setPassword} />
            <TouchableOpacity style={estilos.botonVerde} onPress={entrar} disabled={cargando}>
                {cargando
                    ? <ActivityIndicator color="#fff" />
                    : <Text style={estilos.botonTexto}>{t('entrar')}</Text>}
            </TouchableOpacity>
        </View>
    );
}

// ═══════════════ PANTALLA 2: CARGA OFRECIDA (la clave) ═══════════════
function CargaScreen({ navigation }) {
    const { t } = useLang();
    const [carga, setCarga] = useState(null);
    const [activa, setActiva] = useState(null);

    const cargar = async () => {
        try {
            const [p, a] = await Promise.all([
                api.getPendingLoad(), api.getActiveLoad()
            ]);
            setCarga(p.data); setActiva(a.data);
            if (a.data && !p.data) navigation.replace('EnCurso', { carga: a.data });
        } catch (e) { /* sin conexión: reintenta solo */ }
    };

    useEffect(() => {
        cargar();
        const timer = setInterval(cargar, 60000);
        const sub = Notifications.addNotificationReceivedListener(cargar);
        return () => { clearInterval(timer); sub.remove(); };
    }, []);

    const aceptar = async () => {
        // Sin señal: se guarda en el teléfono y se envía solo cuando vuelva
        const red = await NetInfo.fetch();
        if (!red.isConnected) {
            await encolarAccion({ tipo: 'aceptar', datos: { loadId: carga.id } });
            await guardarCargaLocal(carga);
            Alert.alert('📴 Sin señal', t('sinSenalAceptar'));
            navigation.replace('EnCurso', { carga });
            return;
        }
        try {
            await api.acceptLoad(carga.id);
            await guardarCargaLocal(carga);   // copia local por si se va la señal luego
            navigation.replace('EnCurso', { carga });
        } catch (e) {
            Alert.alert(t('cancelar'), t('yaTomada'));
            cargar();
        }
    };

    const rechazar = async () => {
        Alert.alert(t('rechazar'), t('rechazarPorque'),
            [
                { text: t('motivoPrecio'), onPress: () => mandarRechazo('precio') },
                { text: t('motivoZona'), onPress: () => mandarRechazo('zona') },
                { text: t('motivoHorario'), onPress: () => mandarRechazo('horario') },
                { text: t('cancelar'), style: 'cancel' }
            ]);
    };
    const mandarRechazo = async (razon) => {
        const red = await NetInfo.fetch();
        if (!red.isConnected) {
            await encolarAccion({ tipo: 'rechazar', datos: { loadId: carga.id, razon } });
        } else {
            await api.rejectLoad(carga.id, razon);
        }
        setCarga(null); cargar();
    };

    if (!carga) return (
        <View style={estilos.centro}>
            <Text style={estilos.esperando}>{t('buscando')}</Text>
            <Text style={estilos.hint}>{t('avisoEspera')}</Text>
        </View>
    );

    return (
        <ScrollView style={estilos.fondo}>
            <View style={estilos.tarjetaOferta}>
                <Text style={estilos.tituloOferta}>{t('nuevaCarga')}</Text>
                <Text style={estilos.ruta}>{carga.originCity}, {carga.originState} → {carga.destCity}, {carga.destState}</Text>

                <View style={estilos.filaPrecio}>
                    <Text style={estilos.precio}>${carga.rate}</Text>
                    <Text style={estilos.rpm}>${carga.rpm}/mi ✅</Text>
                </View>
                <Text style={estilos.dato}>🛣️ {carga.miles} {t('millas')}</Text>
                <Text style={estilos.dato}>📦 {carga.commodity || '—'}</Text>
                <Text style={estilos.dato}>📅 {carga.pickupDate} — {carga.pickupTime}</Text>
                <Text style={estilos.dato}>📍 {carga.originAddress}</Text>
                <Text style={estilos.dato}>📅 {carga.deliveryDate}</Text>
                <Text style={estilos.dato}>📍 {carga.destAddress}</Text>

                <View style={estilos.filaBotones}>
                    <TouchableOpacity style={[estilos.botonGrande, { backgroundColor: VERDE }]} onPress={aceptar}>
                        <Text style={estilos.botonTexto}>{t('aceptar')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[estilos.botonGrande, { backgroundColor: ROJO }]} onPress={rechazar}>
                        <Text style={estilos.botonTexto}>{t('rechazar')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </ScrollView>
    );
}

// ═══════════════ PANTALLA 3: CARGA EN CURSO ═══════════════
function EnCursoScreen({ route, navigation }) {
    const { t } = useLang();
    const { carga } = route.params;
    const [etapa, setEtapa] = useState(carga.status || 'ACCEPTED');

    const navegar = (direccion) => {
        Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(direccion)}`);
    };

    const irAFotos = (tipo) => {
        navigation.navigate('Camara', {
            bookingId: carga.bookingId, tipo,
            alTerminar: (nuevoEstado) => setEtapa(nuevoEstado)
        });
    };

    return (
        <ScrollView style={estilos.fondo}>
            <View style={estilos.tarjeta}>
                <Text style={estilos.estado}>
                    {etapa === 'ACCEPTED' ? t('etapaRecoger') :
                     etapa === 'PICKED_UP' ? t('etapaCamino') : t('etapaEntregada')}
                </Text>
                <Text style={estilos.ruta}>{carga.originCity} → {carga.destCity}</Text>
                <Text style={estilos.dato}>💰 ${carga.rate} · {carga.miles} {t('millas')}</Text>
            </View>

            {etapa === 'ACCEPTED' && (
                <View style={estilos.tarjeta}>
                    <Text style={estilos.dato}>{t('recogerEn')} {carga.originAddress}</Text>
                    <TouchableOpacity style={estilos.botonAzul} onPress={() => navegar(carga.originAddress)}>
                        <Text style={estilos.botonTexto}>{t('navegarRecogida')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={estilos.botonVerde} onPress={() => irAFotos('pickup')}>
                        <Text style={estilos.botonTexto}>{t('llegue')}</Text>
                    </TouchableOpacity>
                </View>
            )}

            {etapa === 'PICKED_UP' && (
                <View style={estilos.tarjeta}>
                    <Text style={estilos.dato}>{t('entregarEn')} {carga.destAddress}</Text>
                    <TouchableOpacity style={estilos.botonAzul} onPress={() => navegar(carga.destAddress)}>
                        <Text style={estilos.botonTexto}>{t('navegarEntrega')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={estilos.botonVerde} onPress={() => irAFotos('delivery')}>
                        <Text style={estilos.botonTexto}>{t('entregue')}</Text>
                    </TouchableOpacity>
                </View>
            )}

            {etapa === 'DELIVERED' && (
                <View style={estilos.tarjeta}>
                    <Text style={estilos.entregada}>{t('entregadaTitulo')}</Text>
                    <Text style={estilos.hint}>{t('entregadaHint')}</Text>
                    <TouchableOpacity style={estilos.botonAzul} onPress={() => navigation.replace('Inicio')}>
                        <Text style={estilos.botonTexto}>{t('buscarOtra')}</Text>
                    </TouchableOpacity>
                </View>
            )}
        </ScrollView>
    );
}

// ═══════════════ PANTALLA 4: CÁMARA (fotos de recogida/entrega) ═══════════════
function CamaraScreen({ route, navigation }) {
    const { t } = useLang();
    const { bookingId, tipo, alTerminar } = route.params;
    const [permiso, setPermiso] = useState(null);
    const [fotos, setFotos] = useState([]);
    const camaraRef = useRef(null);

    useEffect(() => {
        Camera.requestCameraPermissionsAsync().then(r => setPermiso(r.granted));
    }, []);

    const tomarFoto = async () => {
        if (camaraRef.current && fotos.length < 3) {
            const foto = await camaraRef.current.takePictureAsync({ quality: 0.5, base64: true });
            setFotos([...fotos, foto.base64]);
        }
    };

    const enviar = async () => {
        const red = await NetInfo.fetch();
        if (!red.isConnected) {
            // Las fotos se guardan en el teléfono y suben solas cuando haya señal
            await encolarAccion({ tipo, datos: { bookingId, photos: fotos } });
            alTerminar(tipo === 'pickup' ? 'PICKED_UP' : 'DELIVERED');
            navigation.goBack();
            return;
        }
        try {
            if (tipo === 'pickup') {
                await api.confirmPickup(bookingId, fotos);
                alTerminar('PICKED_UP');
            } else {
                await api.confirmDelivery(bookingId, fotos);
                alTerminar('DELIVERED');
            }
            navigation.goBack();
        } catch (e) {
            // También sin conexión: a la cola, no se pierde nada
            await encolarAccion({ tipo, datos: { bookingId, photos: fotos } });
            alTerminar(tipo === 'pickup' ? 'PICKED_UP' : 'DELIVERED');
            navigation.goBack();
        }
    };

    if (permiso === false) return <Text style={estilos.hint}>{t('permisoCamara')}</Text>;

    return (
        <View style={{ flex: 1 }}>
            <Camera style={{ flex: 1 }} ref={camaraRef}>
                <View style={estilos.camaraOverlay}>
                    <Text style={estilos.botonTexto}>
                        {tipo === 'pickup' ? t('fotosRecogida') : t('fotosEntrega')} ({fotos.length}/3)
                    </Text>
                    <Text style={estilos.hintCamara}>{t('guiaFotos')}</Text>
                    <View style={estilos.filaBotones}>
                        <TouchableOpacity style={estilos.botonAzul} onPress={tomarFoto}>
                            <Text style={estilos.botonTexto}>{t('tomar')}</Text>
                        </TouchableOpacity>
                        {fotos.length >= 2 && (
                            <TouchableOpacity style={estilos.botonVerde} onPress={enviar}>
                                <Text style={estilos.botonTexto}>{t('enviar')} ({fotos.length})</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            </Camera>
        </View>
    );
}

// ═══════════════ GPS + NOTIFICACIONES (automático tras login) ═══════════════
async function registrarGPSyNotificaciones() {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status === 'granted') {
        const token = (await Notifications.getExpoPushTokenAsync()).data;
        await api.registerPushToken?.(token);
    }
    await Location.requestForegroundPermissionsAsync();
    // Sin datos: el GPS se guarda localmente y se sube en tandas cuando vuelva la señal
    await Location.startLocationUpdatesAsync('gps-microfleet', {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 10 * 60 * 1000,
        foregroundService: { notificationTitle: 'Micro-Fleet', notificationBody: 'Active' }
    }).catch(() => {});
}

// ═══════════════ ESTILOS ═══════════════
const estilos = StyleSheet.create({
    login: { flex: 1, backgroundColor: OSCURO, justifyContent: 'center', padding: 30 },
    logo: { fontSize: 36, fontWeight: '900', color: '#fff', textAlign: 'center', marginBottom: 5 },
    subtitulo: { fontSize: 16, color: '#94A3B8', textAlign: 'center', marginBottom: 30 },
    selectorEtiqueta: { color: '#94A3B8', textAlign: 'center', fontSize: 13, marginBottom: 8 },
    selectorFila: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginBottom: 25 },
    selectorBoton: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: 20, backgroundColor: '#1E293B', borderWidth: 1, borderColor: '#334155' },
    selectorActivo: { backgroundColor: AZUL, borderColor: AZUL },
    selectorTexto: { color: '#fff', fontWeight: 'bold' },
    input: { backgroundColor: '#1E293B', color: '#fff', borderRadius: 10, padding: 15, marginBottom: 15, fontSize: 16 },
    fondo: { flex: 1, backgroundColor: OSCURO, padding: 15 },
    centro: { flex: 1, backgroundColor: OSCURO, justifyContent: 'center', alignItems: 'center', padding: 30 },
    esperando: { fontSize: 20, color: '#fff', fontWeight: 'bold', marginBottom: 15 },
    hint: { color: '#94A3B8', textAlign: 'center', fontSize: 14 },
    tarjetaOferta: { backgroundColor: '#1E293B', borderRadius: 16, padding: 20, borderWidth: 2, borderColor: VERDE, marginTop: 20 },
    tarjeta: { backgroundColor: '#1E293B', borderRadius: 16, padding: 20, marginBottom: 15 },
    tituloOferta: { color: VERDE, fontWeight: '900', fontSize: 18, marginBottom: 10 },
    ruta: { color: '#fff', fontSize: 22, fontWeight: 'bold', marginBottom: 10 },
    filaPrecio: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginBottom: 8 },
    precio: { color: VERDE, fontSize: 36, fontWeight: '900' },
    rpm: { color: '#F59E0B', fontSize: 16, fontWeight: 'bold' },
    dato: { color: '#CBD5E1', fontSize: 15, marginBottom: 5 },
    estado: { color: '#F59E0B', fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
    entregada: { color: VERDE, fontSize: 24, fontWeight: '900', textAlign: 'center', marginBottom: 10 },
    filaBotones: { flexDirection: 'row', gap: 12, marginTop: 20 },
    botonGrande: { flex: 1, padding: 18, borderRadius: 12, alignItems: 'center' },
    botonAzul: { backgroundColor: AZUL, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 12 },
    botonVerde: { backgroundColor: VERDE, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 12 },
    botonTexto: { color: '#fff', fontWeight: '900', fontSize: 16 },
    camaraOverlay: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 40, backgroundColor: 'rgba(0,0,0,0.3)' },
    hintCamara: { color: '#E2E8F0', fontSize: 13, marginBottom: 15 }
});

// ═══════════════ ARRANQUE (recuerda el idioma elegido) ═══════════════
export default function App() {
    const [lang, setLang] = useState('es');

    useEffect(() => {
        cargarIdioma().then(setLang);
        vigilarSenal();        // en cuanto vuelva la señal, vacía la cola pendiente
        intentarSincronizar(); // por si hay cosas pendientes de antes
    }, []);

    return (
        <LangContext.Provider value={{ lang, setLang, t: (k) => TEXTOS[lang][k] || k }}>
            <NavigationContainer>
                <Stack.Navigator screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="Login" component={LoginScreen} />
                    <Stack.Screen name="Inicio" component={CargaScreen} />
                    <Stack.Screen name="EnCurso" component={EnCursoScreen} />
                    <Stack.Screen name="Camara" component={CamaraScreen} />
                </Stack.Navigator>
            </NavigationContainer>
        </LangContext.Provider>
    );
}
