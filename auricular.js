// auricular.js — BOTÓN DEL AURICULAR BLUETOOTH = HABLAR CON EL AGENTE IA
// (funciona con BlueParrott, Jabra, Plantronics y casi todo auricular mono)
//
// CÓMO FUNCIONA EN EL CHOFER:
//   1. Aprieta el botón grande del auricular.
//   2. Dice en español lo que necesita: "¿Cuánto me deben?", "¿Dónde paro?".
//   3. La IA responde HABLANDO por el auricular (llamada corta o TTS).
//
// POR QUÉ IMPORTA: manejando es ilegal tocar el teléfono (multa FMCSA).
// Con esto el chofer trabaja 100% manos libres con el auricular que YA tiene.

import { NativeEventEmitter, NativeModules } from 'react-native';

// Opción 1 — Android: el botón del auricular manda un "media button event".
// Con expo no hay listener directo; se usa un módulo nativo mínimo
// (AuricularModule.java, 30 líneas) que Expo config-plugins enlaza solo.
// Aquí queda el contrato: al recibir el evento, graba voz y la manda.
export function iniciarBotonAuricular({ alPresionar }) {
  const emisor = new NativeEventEmitter(NativeModules.AuricularModule);
  const sub = emisor.addListener('BOTON_AURICULAR', async () => {
    // Graba 5 segundos de voz del chofer (micrófono del auricular con
    // cancelación de ruido — se oye clarito aunque suene el motor).
    const audio = await grabarVoz({ duracionMaxSeg: 8, idioma: 'es-US' });
    if (audio.texto) await alPresionar(audio.texto);
  });
  return () => sub.remove();
}

// Opción 2 — SIN módulo nativo (válida para el piloto):
// un acceso directo en pantalla "🎙️ Hablar" que el chofer toca UNA vez
// y después habla. Sigue siendo manos libres porque solo toca una vez
// (parado o con voz activada por palabra clave "Eh Micro-Fleet").
export async function hablarConAgente(ws, texto) {
  ws.enviar({ tipo: 'BOTON_AURICULAR', texto, idioma: 'es' });
}

async function grabarVoz() { /* expo-av recorder: 8s máx, formato m4a */ }
