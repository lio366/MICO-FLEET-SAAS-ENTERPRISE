// ============================================================================
// 36_onboarding_csv.js — IMPORTAR CHOFERES Y CARGAS DESDE EXCEL/CSV
// Versión 5.1
//
// Por qué existe: un broker nuevo no empieza de cero — tiene sus camiones y
// clientes en una hoja de Excel. Los competidores (LogisticsX) incluyen
// importación CSV como función estándar. Con esto, subir un archivo y listo.
// Funciona SIN librerías externas: parsea CSV simple (coma o punto y coma).
// ============================================================================

// ---------------------------------------------------------------------------
// Parser CSV mínimo y robusto: respeta comillas, saltos de línea, BOM de Excel
// ---------------------------------------------------------------------------
function parsearCSV(texto) {
  texto = texto.replace(/^\uFEFF/, '');              // quita BOM de Excel
  const filas = []; let campo = '', fila = [], enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else enComillas = false; }
      else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ',' || c === ';') { fila.push(campo.trim()); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (campo !== '' || fila.length) { fila.push(campo.trim()); filas.push(fila); fila = []; campo = ''; }
      if (c === '\r' && texto[i + 1] === '\n') i++;
    } else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo.trim()); filas.push(fila); }
  return filas;
}

// ---------------------------------------------------------------------------
// Plantillas de columnas (la primera fila del CSV debe tener estos nombres,
// en español o inglés, mayúsculas o minúsculas — el mapeo es tolerante)
// ---------------------------------------------------------------------------
const COLUMNAS_CHOFER = {
  nombre: ['nombre', 'name', 'conductor'], apellido: ['apellido', 'last'],
  telefono: ['telefono', 'phone', 'teléfono'], email: ['email', 'correo'],
  mc: ['mc', 'mc_number', 'mc numero'], camion: ['camion', 'truck', 'unidad'],
  notas: ['notas', 'notes']
};
const COLUMNAS_CARGA = {
  origen: ['origen', 'origin'], destino: ['destino', 'destination'],
  millas: ['millas', 'miles'], tarifa: ['tarifa', 'rate', 'precio'],
  recogida: ['recogida', 'pickup'], entrega: ['entrega', 'delivery']
};

function mapearEncabezados(encabezados, plantilla) {
  const mapa = {};
  encabezados.forEach((h, i) => {
    const clave = h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (const [campo, sinonimos] of Object.entries(plantilla)) {
      if (sinonimos.includes(clave)) mapa[campo] = i;
    }
  });
  return mapa;
}

// ---------------------------------------------------------------------------
// Importar choferes: valida cada fila, rechaza las incompletas con motivo,
// y reporta cuántas entraron y cuáles fallaron (transparencia total)
// ---------------------------------------------------------------------------
async function importarChoferes(db, tenantId, csvTexto) {
  const filas = parsearCSV(csvTexto);
  if (filas.length < 2) return { error: 'El archivo está vacío o no tiene datos' };

  const mapa = mapearEncabezados(filas[0], COLUMNAS_CHOFER);
  if (mapa.nombre === undefined || mapa.telefono === undefined)
    return { error: 'Faltan columnas obligatorias: nombre y telefono' };

  const ok = [], fallos = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i];
    const nombre = f[mapa.nombre], telefono = (f[mapa.telefono] || '').replace(/\D/g, '');
    if (!nombre || telefono.length < 10) {
      fallos.push({ fila: i + 1, motivo: !nombre ? 'sin nombre' : 'teléfono inválido (necesita 10 dígitos)' });
      continue;
    }
    await db.query(
      `INSERT INTO drivers (tenant_id, full_name, phone, email, mc_number, truck_number, notes, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
       ON CONFLICT DO NOTHING`,
      [tenantId, nombre, telefono, f[mapa.email] || null, f[mapa.mc] || null,
       f[mapa.camion] || null, f[mapa.notas] || null]
    );
    ok.push(nombre);
  }
  return { importados: ok.length, nombres: ok, rechazados: fallos };
}

// ---------------------------------------------------------------------------
// Importar cargas pendientes (mismo patrón)
// ---------------------------------------------------------------------------
async function importarCargas(db, tenantId, csvTexto) {
  const filas = parsearCSV(csvTexto);
  if (filas.length < 2) return { error: 'El archivo está vacío o no tiene datos' };

  const mapa = mapearEncabezados(filas[0], COLUMNAS_CARGA);
  if (mapa.origen === undefined || mapa.destino === undefined || mapa.tarifa === undefined)
    return { error: 'Faltan columnas obligatorias: origen, destino, tarifa' };

  const ok = [], fallos = [];
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i];
    const tarifa = parseFloat((f[mapa.tarifa] || '').replace(/[$,]/g, ''));
    if (!f[mapa.origen] || !f[mapa.destino] || !(tarifa > 0)) {
      fallos.push({ fila: i + 1, motivo: 'origen/destino vacíos o tarifa inválida' });
      continue;
    }
    await db.query(
      `INSERT INTO loads (tenant_id, origin_city, dest_city, miles, rate, pickup_at, delivery_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AVAILABLE')`,
      [tenantId, f[mapa.origen], f[mapa.destino], parseFloat(f[mapa.millas]) || null,
       tarifa, f[mapa.recogida] || null, f[mapa.entrega] || null]
    );
    ok.push(`${f[mapa.origen]}→${f[mapa.destino]} $${tarifa}`);
  }
  return { importadas: ok.length, cargas: ok, rechazadas: fallos };
}

module.exports = { parsearCSV, importarChoferes, importarCargas };
