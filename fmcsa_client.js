// ============================================================================
// services/fmcsa_client.js — ADAPTADOR DE LA API PÚBLICA DE FMCSA
// Lo usa: 33 (verificación del carrier). Datos oficiales del gobierno,
// gratuitos con webKey (se solicita en la web de FMCSA, Developer Resources).
// ============================================================================

const https = require('https');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MicroFleet/5.4 (tour567 verification)' } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Consulta el snapshot SAFER del transportista: autoridad + seguros reportados
// por las aseguradoras. Sin webKey configurada lanza error claro (no silencioso).
async function consultarCarrier({ mcNumero, dotNumero }) {
  const webKey = process.env.FMCSA_API_KEY;
  if (!webKey) throw new Error('Falta FMCSA_API_KEY en el entorno (gratis: fmcsa.dot.gov Developer Resources)');
  const param = mcNumero ? `MC_NUMBER=${encodeURIComponent(mcNumero)}`
                         : `DOT_NUMBER=${encodeURIComponent(dotNumero)}`;
  const d = await getJSON(`https://api.fmcsa.dot.gov/FMCSA_SAFER_CompanySnapshot?${param}&webKey=${webKey}`);
  return {
    autoridadActiva: d?.record_status === 'ACTIVE',
    segurosVigentes: Array.isArray(d?.insurance) && d.insurance.some(i => i.status === 'ACTIVE'),
    razonSocial: d?.legal_name || null,
    consultadoEn: new Date().toISOString()
  };
}

module.exports = { consultarCarrier };
