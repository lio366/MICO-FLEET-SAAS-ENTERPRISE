'use strict';
// pg-compat — Driver PostgreSQL (protocolo frontend/backend v3) en Node.js puro, sin dependencias.
// Implementa el subconjunto de la API de `pg` (node-postgres) que usa Micro Fleet:
//   new Pool({ connectionString, max, idleTimeoutMillis, connectionTimeoutMillis })
//   pool.query(text, values?) · pool.connect() → client · client.query() · client.release(err?)
//   pool.end() · new Client(config) · client.connect() · client.end()
// Errores del servidor: Error con code, severity, detail, hint, constraint, table, column, schema, where, position.
// Autenticación: trust, cleartext, MD5 y SCRAM-SHA-256 (RFC 5802 / RFC 7677).
// Tipos: bool, int2/int4/oid → number; int8/numeric → string; float4/float8 → number; json/jsonb → objeto;
//        timestamptz/timestamp/date → Date; bytea → Buffer; arrays 1-D de los anteriores; resto → string.
// Ámbito: herramienta de validación de integración cuando el registro npm no es accesible.
// No implementa TLS, COPY, cursores ni LISTEN/NOTIFY: para producción se usa el paquete oficial `pg`.

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
function parseConnectionString(str) {
  const u = new URL(str);
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) {
    throw new Error(`pg-compat: protocolo no soportado en connectionString: ${u.protocol}`);
  }
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode && !['disable', 'prefer', 'allow'].includes(sslmode)) {
    throw new Error(`pg-compat: sslmode=${sslmode} requiere TLS, no soportado por esta herramienta`);
  }
  return {
    host: u.hostname ? decodeURIComponent(u.hostname) : (u.searchParams.get('host') || '127.0.0.1'),
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username || process.env.PGUSER || process.env.USER || ''),
    password: u.password ? decodeURIComponent(u.password) : (process.env.PGPASSWORD || ''),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined,
    application_name: u.searchParams.get('application_name') || undefined,
  };
}

function normalizeConfig(config = {}) {
  const base = config.connectionString ? parseConnectionString(config.connectionString) : {};
  const cfg = {
    host: config.host || base.host || process.env.PGHOST || '127.0.0.1',
    port: Number(config.port || base.port || process.env.PGPORT || 5432),
    user: config.user || base.user || process.env.PGUSER || '',
    password: config.password ?? base.password ?? process.env.PGPASSWORD ?? '',
    database: config.database || base.database || process.env.PGDATABASE,
    application_name: config.application_name || base.application_name || 'pg-compat',
    connectionTimeoutMillis: Number(config.connectionTimeoutMillis || 0),
    statement_timeout: config.statement_timeout,
  };
  if (!cfg.database) cfg.database = cfg.user;
  return cfg;
}

// ---------------------------------------------------------------------------
// Serialización de parámetros (formato texto)
// ---------------------------------------------------------------------------
function arrayLiteral(arr) {
  const parts = arr.map(v => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return arrayLiteral(v);
    const s = serializeParam(v);
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  });
  return '{' + parts.join(',') + '}';
}

function serializeParam(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TypeError('pg-compat: Date inválida como parámetro');
    return v.toISOString();
  }
  if (Array.isArray(v)) return arrayLiteral(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') {
    if (typeof v.toPostgres === 'function') return serializeParam(v.toPostgres(serializeParam));
    return JSON.stringify(v);
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Parsers de tipos (formato texto)
// ---------------------------------------------------------------------------
function parseBytea(s) {
  if (s.startsWith('\\x')) return Buffer.from(s.slice(2), 'hex');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      if (s[i + 1] === '\\') { out.push(0x5c); i++; }
      else { out.push(parseInt(s.substr(i + 1, 3), 8)); i += 3; }
    } else out.push(s.charCodeAt(i));
  }
  return Buffer.from(out);
}

function parseTimestamp(s, withTz) {
  if (s === 'infinity') return Infinity;
  if (s === '-infinity') return -Infinity;
  const m = /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?( BC)?$/.exec(s);
  if (!m) return new Date(s);
  let year = Number(m[1]);
  if (m[9]) year = 1 - year;
  const ms = m[7] ? Math.round(Number('0' + m[7]) * 1000) : 0;
  const args = [year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms];
  if (!withTz || !m[8]) {
    const d = new Date(...args);
    if (year < 100) d.setFullYear(year);
    return d;
  }
  let offsetMs = 0;
  if (m[8] !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    const digits = m[8].slice(1).replace(/:/g, '');
    const hh = Number(digits.slice(0, 2));
    const mm = Number(digits.slice(2, 4) || 0);
    const ss = Number(digits.slice(4, 6) || 0);
    offsetMs = sign * ((hh * 3600) + (mm * 60) + ss) * 1000;
  }
  const utc = Date.UTC(...args);
  const d = new Date(utc - offsetMs);
  if (year < 100) d.setUTCFullYear(year);
  return d;
}

function parseDate(s) {
  if (s === 'infinity') return Infinity;
  if (s === '-infinity') return -Infinity;
  const m = /^(\d{4,})-(\d{2})-(\d{2})( BC)?$/.exec(s);
  if (!m) return new Date(s);
  let year = Number(m[1]);
  if (m[4]) year = 1 - year;
  const d = new Date(year, Number(m[2]) - 1, Number(m[3]));
  if (year < 100) d.setFullYear(year);
  return d;
}

function parseArray(s, elementParser) {
  let i = 0;
  if (s[0] === '[') { i = s.indexOf('=') + 1; }
  function parseLevel() {
    if (s[i] !== '{') throw new Error(`pg-compat: literal de array inválido: ${s}`);
    i++;
    const out = [];
    if (s[i] === '}') { i++; return out; }
    for (;;) {
      if (s[i] === '{') out.push(parseLevel());
      else if (s[i] === '"') {
        i++;
        let val = '';
        while (s[i] !== '"') {
          if (s[i] === '\\') { i++; }
          val += s[i]; i++;
        }
        i++;
        out.push(elementParser(val));
      } else {
        let start = i;
        while (s[i] !== ',' && s[i] !== '}') i++;
        const raw = s.slice(start, i);
        out.push(raw === 'NULL' ? null : elementParser(raw));
      }
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return out; }
      throw new Error(`pg-compat: literal de array inválido: ${s}`);
    }
  }
  return parseLevel();
}

const identity = v => v;
const toInt = v => parseInt(v, 10);
const toFloat = v => parseFloat(v);
const toBool = v => v === 't' || v === 'true';
const toJson = v => JSON.parse(v);
const toTz = v => parseTimestamp(v, true);
const toTs = v => parseTimestamp(v, false);

const TYPE_PARSERS = new Map([
  [16, toBool], [17, parseBytea], [20, identity], [21, toInt], [23, toInt], [26, toInt],
  [114, toJson], [3802, toJson], [700, toFloat], [701, toFloat], [1700, identity],
  [1082, parseDate], [1114, toTs], [1184, toTz],
  [1000, v => parseArray(v, toBool)], [1001, v => parseArray(v, parseBytea)],
  [1005, v => parseArray(v, toInt)], [1007, v => parseArray(v, toInt)],
  [1016, v => parseArray(v, identity)], [1021, v => parseArray(v, toFloat)],
  [1022, v => parseArray(v, toFloat)], [1009, v => parseArray(v, identity)],
  [1015, v => parseArray(v, identity)], [1014, v => parseArray(v, identity)],
  [199, v => parseArray(v, toJson)], [3807, v => parseArray(v, toJson)],
  [1115, v => parseArray(v, toTs)], [1185, v => parseArray(v, toTz)],
  [1182, v => parseArray(v, parseDate)], [1231, v => parseArray(v, identity)],
  [2951, v => parseArray(v, identity)],
]);

const types = {
  setTypeParser(oid, format, fn) {
    TYPE_PARSERS.set(Number(oid), typeof format === 'function' ? format : fn);
  },
  getTypeParser(oid) { return TYPE_PARSERS.get(Number(oid)) || identity; },
  builtins: { BOOL: 16, BYTEA: 17, INT8: 20, INT2: 21, INT4: 23, OID: 26, JSON: 114, JSONB: 3802,
    FLOAT4: 700, FLOAT8: 701, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184, TEXT: 25, UUID: 2950 },
};

// ---------------------------------------------------------------------------
// Codificación de mensajes frontend
// ---------------------------------------------------------------------------
class Writer {
  constructor() { this.chunks = []; this.len = 0; }
  int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return this.push(b); }
  int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return this.push(b); }
  cstr(s) { return this.push(Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])); }
  bytes(b) { return this.push(b); }
  push(b) { this.chunks.push(b); this.len += b.length; return this; }
  build(type) {
    const body = Buffer.concat(this.chunks, this.len);
    const header = Buffer.alloc(type ? 5 : 4);
    if (type) { header.write(type, 0, 'ascii'); header.writeInt32BE(body.length + 4, 1); }
    else header.writeInt32BE(body.length + 4, 0);
    return Buffer.concat([header, body]);
  }
}

function msgStartup(cfg) {
  const w = new Writer().int32(196608);
  w.cstr('user').cstr(cfg.user);
  if (cfg.database) w.cstr('database').cstr(cfg.database);
  w.cstr('application_name').cstr(cfg.application_name);
  w.cstr('client_encoding').cstr('UTF8');
  w.cstr('DateStyle').cstr('ISO, MDY');
  if (cfg.statement_timeout) w.cstr('options').cstr(`-c statement_timeout=${Number(cfg.statement_timeout)}`);
  w.push(Buffer.from([0]));
  return w.build(null);
}
const msgPassword = (data) => new Writer().bytes(Buffer.isBuffer(data) ? data : Buffer.concat([Buffer.from(data, 'utf8'), Buffer.from([0])])).build('p');
function msgSASLInitial(mechanism, data) {
  const payload = Buffer.from(data, 'utf8');
  return new Writer().cstr(mechanism).int32(payload.length).bytes(payload).build('p');
}
const msgSASLResponse = (data) => new Writer().bytes(Buffer.from(data, 'utf8')).build('p');
const msgQuery = (text) => new Writer().cstr(text).build('Q');
function msgParse(text) { return new Writer().cstr('').cstr(text).int16(0).build('P'); }
function msgBind(values) {
  const w = new Writer().cstr('').cstr('').int16(0).int16(values.length);
  for (const v of values) {
    const s = serializeParam(v);
    if (s === null) w.int32(-1);
    else { const b = Buffer.from(s, 'utf8'); w.int32(b.length).bytes(b); }
  }
  w.int16(0);
  return w.build('B');
}
const msgDescribePortal = () => new Writer().push(Buffer.from('P')).cstr('').build('D');
const msgExecute = () => new Writer().cstr('').int32(0).build('E');
const msgSync = () => new Writer().build('S');
const msgTerminate = () => new Writer().build('X');

// ---------------------------------------------------------------------------
// SCRAM-SHA-256
// ---------------------------------------------------------------------------
function saslprepPassword(p) { return p.normalize('NFKC'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function xor(a, b) { const out = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]; return out; }

class Scram {
  constructor(password) {
    this.password = saslprepPassword(password);
    this.clientNonce = crypto.randomBytes(18).toString('base64');
    this.clientFirstBare = `n=*,r=${this.clientNonce}`;
  }
  first() { return `n,,${this.clientFirstBare}`; }
  continue(serverFirst) {
    const attrs = Object.fromEntries(serverFirst.split(',').map(kv => [kv[0], kv.slice(2)]));
    if (!attrs.r || !attrs.r.startsWith(this.clientNonce)) throw new Error('pg-compat SCRAM: nonce del servidor inválido');
    if (!attrs.s || !attrs.i) throw new Error('pg-compat SCRAM: respuesta del servidor incompleta');
    const salt = Buffer.from(attrs.s, 'base64');
    const iterations = Number(attrs.i);
    const salted = crypto.pbkdf2Sync(this.password, salt, iterations, 32, 'sha256');
    const clientKey = hmac(salted, 'Client Key');
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();
    const clientFinalNoProof = `c=biws,r=${attrs.r}`;
    const authMessage = `${this.clientFirstBare},${serverFirst},${clientFinalNoProof}`;
    const clientSignature = hmac(storedKey, authMessage);
    const proof = xor(clientKey, clientSignature).toString('base64');
    const serverKey = hmac(salted, 'Server Key');
    this.expectedServerSignature = hmac(serverKey, authMessage).toString('base64');
    return `${clientFinalNoProof},p=${proof}`;
  }
  final(serverFinal) {
    const m = /(?:^|,)v=([^,]+)/.exec(serverFinal);
    if (!m) throw new Error('pg-compat SCRAM: firma final del servidor ausente');
    const a = Buffer.from(m[1]); const b = Buffer.from(this.expectedServerSignature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('pg-compat SCRAM: firma del servidor no coincide');
  }
}

// ---------------------------------------------------------------------------
// Error de base de datos
// ---------------------------------------------------------------------------
const ERROR_FIELDS = { S: 'severity', V: 'severityNonLocalized', C: 'code', M: 'message', D: 'detail', H: 'hint',
  P: 'position', p: 'internalPosition', q: 'internalQuery', W: 'where', s: 'schema', t: 'table', c: 'column',
  d: 'dataType', n: 'constraint', F: 'file', L: 'line', R: 'routine' };

function parseErrorFields(buf) {
  const fields = {};
  let i = 0;
  while (i < buf.length && buf[i] !== 0) {
    const key = String.fromCharCode(buf[i]);
    const end = buf.indexOf(0, i + 1);
    fields[ERROR_FIELDS[key] || key] = buf.toString('utf8', i + 1, end);
    i = end + 1;
  }
  return fields;
}

class DatabaseError extends Error {
  constructor(fields) {
    super(fields.message || 'error de PostgreSQL');
    this.name = 'error';
    for (const [k, v] of Object.entries(fields)) if (k !== 'message') this[k] = v;
    this.length = undefined;
  }
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------
class Client extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = normalizeConfig(typeof config === 'string' ? { connectionString: config } : config);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.active = null;
    this.connected = false;
    this.ending = false;
    this.parameters = {};
    this.processID = null;
    this.secretKey = null;
    this._connectPromise = null;
  }

  connect(callback) {
    if (this._connectPromise) {
      const p = Promise.reject(new Error('pg-compat: el cliente ya fue conectado y no se puede reutilizar'));
      if (callback) { p.catch(callback); return undefined; }
      return p;
    }
    this._connectPromise = new Promise((resolve, reject) => {
      const cfg = this.config;
      let settled = false;
      let timer = null;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (this.socket) this.socket.destroy();
        reject(err);
      };
      const socket = net.createConnection({ host: cfg.host, port: cfg.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true);
      if (cfg.connectionTimeoutMillis > 0) {
        timer = setTimeout(() => fail(new Error('pg-compat: timeout de conexión')), cfg.connectionTimeoutMillis);
      }
      let scram = null;
      this._handshake = (type, body) => {
        try {
          switch (type) {
            case 'R': {
              const code = body.readInt32BE(0);
              if (code === 0) return;
              if (code === 3) { socket.write(msgPassword(cfg.password)); return; }
              if (code === 5) {
                const salt = body.subarray(4, 8);
                const inner = crypto.createHash('md5').update(cfg.password + cfg.user).digest('hex');
                const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
                socket.write(msgPassword('md5' + outer));
                return;
              }
              if (code === 10) {
                const mechanisms = body.toString('utf8', 4).split('\0').filter(Boolean);
                if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error(`pg-compat: mecanismos SASL no soportados: ${mechanisms.join(',')}`);
                if (!cfg.password) throw new Error('pg-compat: SCRAM requiere contraseña');
                scram = new Scram(cfg.password);
                socket.write(msgSASLInitial('SCRAM-SHA-256', scram.first()));
                return;
              }
              if (code === 11) { socket.write(msgSASLResponse(scram.continue(body.toString('utf8', 4)))); return; }
              if (code === 12) { scram.final(body.toString('utf8', 4)); return; }
              throw new Error(`pg-compat: método de autenticación no soportado (${code})`);
            }
            case 'S': {
              const k = body.toString('utf8', 0, body.indexOf(0));
              const v = body.toString('utf8', body.indexOf(0) + 1, body.length - 1);
              this.parameters[k] = v;
              return;
            }
            case 'K': this.processID = body.readInt32BE(0); this.secretKey = body.readInt32BE(4); return;
            case 'N': this.emit('notice', new DatabaseError(parseErrorFields(body))); return;
            case 'E': fail(new DatabaseError(parseErrorFields(body))); return;
            case 'Z':
              this._handshake = null;
              this.connected = true;
              settled = true;
              if (timer) clearTimeout(timer);
              resolve(this);
              this._drain();
              return;
            default: return;
          }
        } catch (e) { fail(e); }
      };
      socket.on('connect', () => socket.write(msgStartup(cfg)));
      socket.on('data', chunk => this._onData(chunk));
      socket.on('error', err => {
        if (!settled) { fail(err); return; }
        this._fatal(err);
      });
      socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (!settled) { fail(new Error('pg-compat: conexión cerrada durante el arranque')); return; }
        if (!this.ending) this._fatal(new Error('Connection terminated unexpectedly'));
        if (wasConnected) this.emit('end');
      });
    });
    if (callback) { this._connectPromise.then(() => callback(null, this), callback); return undefined; }
    return this._connectPromise;
  }

  _fatal(err) {
    const pending = [];
    if (this.active) pending.push(this.active);
    pending.push(...this.queue);
    this.active = null;
    this.queue = [];
    for (const q of pending) q.reject(err);
    if (!this.ending) this.emit('error', err);
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let offset = 0;
    while (this.buffer.length - offset >= 5) {
      const type = String.fromCharCode(this.buffer[offset]);
      const len = this.buffer.readInt32BE(offset + 1);
      if (this.buffer.length - offset < len + 1) break;
      const body = this.buffer.subarray(offset + 5, offset + 1 + len);
      offset += len + 1;
      if (this._handshake) this._handshake(type, body);
      else this._onMessage(type, body);
    }
    this.buffer = offset === this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset);
  }

  _onMessage(type, body) {
    const q = this.active;
    switch (type) {
      case 'T': {
        const n = body.readInt16BE(0);
        let i = 2;
        const fields = [];
        for (let k = 0; k < n; k++) {
          const end = body.indexOf(0, i);
          const name = body.toString('utf8', i, end);
          i = end + 1;
          const tableID = body.readInt32BE(i);
          const columnID = body.readInt16BE(i + 4);
          const dataTypeID = body.readInt32BE(i + 6);
          const dataTypeSize = body.readInt16BE(i + 10);
          const dataTypeModifier = body.readInt32BE(i + 12);
          const format = body.readInt16BE(i + 16) === 0 ? 'text' : 'binary';
          i += 18;
          fields.push({ name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, format,
            parser: types.getTypeParser(dataTypeID) });
        }
        if (q) q.current = { command: null, rowCount: null, oid: null, rows: [], fields };
        return;
      }
      case 'D': {
        if (!q || !q.current) return;
        const n = body.readInt16BE(0);
        let i = 2;
        const row = {};
        const fields = q.current.fields;
        for (let k = 0; k < n; k++) {
          const len = body.readInt32BE(i);
          i += 4;
          const f = fields[k];
          if (len === -1) { row[f.name] = null; continue; }
          const raw = body.toString('utf8', i, i + len);
          i += len;
          row[f.name] = f.parser(raw);
        }
        q.current.rows.push(row);
        return;
      }
      case 'C': {
        if (!q) return;
        const tag = body.toString('utf8', 0, body.length - 1);
        const parts = tag.split(' ');
        const r = q.current || { rows: [], fields: [] };
        r.command = parts[0];
        const last = Number(parts[parts.length - 1]);
        r.rowCount = Number.isFinite(last) && parts.length > 1 ? last : null;
        r.oid = parts[0] === 'INSERT' ? Number(parts[1]) : null;
        q.results.push(finalizeResult(r));
        q.current = null;
        return;
      }
      case 'I': if (q) { q.results.push(finalizeResult({ command: null, rowCount: null, oid: null, rows: [], fields: [] })); q.current = null; } return;
      case 'E': if (q && !q.error) q.error = new DatabaseError(parseErrorFields(body)); if (q) q.current = null; return;
      case 'N': this.emit('notice', new DatabaseError(parseErrorFields(body))); return;
      case 'S': {
        const k = body.toString('utf8', 0, body.indexOf(0));
        this.parameters[k] = body.toString('utf8', body.indexOf(0) + 1, body.length - 1);
        return;
      }
      case 'A': {
        const pid = body.readInt32BE(0);
        const e1 = body.indexOf(0, 4);
        this.emit('notification', { processId: pid, channel: body.toString('utf8', 4, e1),
          payload: body.toString('utf8', e1 + 1, body.indexOf(0, e1 + 1)) });
        return;
      }
      case 'Z': {
        this.transactionStatus = String.fromCharCode(body[0]);
        this.active = null;
        if (q) {
          if (q.error) q.reject(q.error);
          else if (q.results.length === 0) q.resolve(finalizeResult({ command: null, rowCount: null, oid: null, rows: [], fields: [] }));
          else q.resolve(q.results.length === 1 ? q.results[0] : q.results);
        }
        this._drain();
        return;
      }
      case '1': case '2': case 'n': case 's': case 't': return;
      default: return;
    }
  }

  _drain() {
    if (this.active || !this.connected || this.queue.length === 0) return;
    const q = this.queue.shift();
    this.active = q;
    try {
      if (q.values === undefined) this.socket.write(msgQuery(q.text));
      else {
        this.socket.write(Buffer.concat([msgParse(q.text), msgBind(q.values), msgDescribePortal(), msgExecute(), msgSync()]));
      }
    } catch (e) {
      this.active = null;
      q.reject(e);
      this._drain();
    }
  }

  query(textOrConfig, values, callback) {
    if (typeof values === 'function') { callback = values; values = undefined; }
    let text = textOrConfig;
    if (textOrConfig && typeof textOrConfig === 'object') { text = textOrConfig.text; values = values ?? textOrConfig.values; }
    if (typeof text !== 'string') {
      const err = new TypeError('pg-compat: el texto de la consulta debe ser string');
      if (callback) { process.nextTick(callback, err); return undefined; }
      return Promise.reject(err);
    }
    const p = new Promise((resolve, reject) => {
      if (this.ending || (!this.connected && !this._connectPromise)) {
        reject(new Error('Client was closed and is not queryable'));
        return;
      }
      this.queue.push({ text, values: Array.isArray(values) ? values : undefined, resolve, reject, results: [], current: null, error: null });
      this._drain();
    });
    if (callback) { p.then(r => callback(null, r), callback); return undefined; }
    return p;
  }

  end(callback) {
    const p = new Promise(resolve => {
      if (!this.socket || this.socket.destroyed) { this.ending = true; resolve(); return; }
      this.ending = true;
      this.socket.once('close', () => resolve());
      try { this.socket.end(msgTerminate()); } catch (_) { this.socket.destroy(); }
    });
    if (callback) { p.then(() => callback(), callback); return undefined; }
    return p;
  }
}

function finalizeResult(r) {
  return { command: r.command, rowCount: r.rowCount, oid: r.oid, rows: r.rows,
    fields: r.fields.map(({ parser, ...f }) => f) };
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------
class Pool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { max: 10, idleTimeoutMillis: 10000, ...options };
    this._clients = new Set();
    this._idle = [];
    this._waiting = [];
    this.ending = false;
    this.ended = false;
  }
  get totalCount() { return this._clients.size; }
  get idleCount() { return this._idle.length; }
  get waitingCount() { return this._waiting.length; }

  async _create() {
    const client = new Client(this.options);
    this._clients.add(client);
    client.on('error', err => {
      this._remove(client);
      this.emit('error', err, client);
    });
    try {
      await client.connect();
    } catch (e) {
      this._clients.delete(client);
      throw e;
    }
    this.emit('connect', client);
    return client;
  }

  _remove(client) {
    this._clients.delete(client);
    const i = this._idle.findIndex(x => x.client === client);
    if (i >= 0) { clearTimeout(this._idle[i].timer); this._idle.splice(i, 1); }
    client.end().catch(() => {});
    this._pump();
  }

  _wrap(client) {
    let released = false;
    client.release = (err) => {
      if (released) throw new Error('Release called on client which has already been released to the pool.');
      released = true;
      if (err || this.ending || !client.connected || client.transactionStatus === 'E') {
        this._remove(client);
        return;
      }
      if (client.transactionStatus === 'T') {
        // Transacción abierta devuelta al pool: no reutilizar una conexión con estado ambiguo.
        this._remove(client);
        return;
      }
      if (this._waiting.length) {
        const w = this._waiting.shift();
        w.resolve(this._wrap(client));
        return;
      }
      const timer = this.options.idleTimeoutMillis > 0
        ? setTimeout(() => this._remove(client), this.options.idleTimeoutMillis)
        : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      this._idle.push({ client, timer });
    };
    return client;
  }

  _pump() {
    while (this._waiting.length && this._clients.size < this.options.max && !this.ending) {
      const w = this._waiting.shift();
      this._create().then(c => w.resolve(this._wrap(c)), w.reject);
    }
  }

  connect(callback) {
    const p = new Promise((resolve, reject) => {
      if (this.ending) { reject(new Error('Cannot use a pool after calling end on the pool')); return; }
      const idle = this._idle.pop();
      if (idle) { clearTimeout(idle.timer); resolve(this._wrap(idle.client)); return; }
      if (this._clients.size < this.options.max) {
        this._create().then(c => resolve(this._wrap(c)), reject);
        return;
      }
      const w = { resolve, reject };
      this._waiting.push(w);
      if (this.options.connectionTimeoutMillis > 0) {
        setTimeout(() => {
          const i = this._waiting.indexOf(w);
          if (i >= 0) { this._waiting.splice(i, 1); reject(new Error('timeout exceeded when trying to connect')); }
        }, this.options.connectionTimeoutMillis);
      }
    });
    if (callback) { p.then(c => callback(null, c, c.release), callback); return undefined; }
    return p;
  }

  async query(text, values, callback) {
    if (typeof values === 'function') { callback = values; values = undefined; }
    const run = async () => {
      const client = await this.connect();
      try {
        const r = await client.query(text, values);
        client.release();
        return r;
      } catch (e) {
        client.release(e && !e.code ? e : undefined);
        throw e;
      }
    };
    if (callback) { run().then(r => callback(null, r), callback); return undefined; }
    return run();
  }

  async end(callback) {
    if (this.ending) {
      const err = new Error('Called end on pool more than once');
      if (callback) { callback(err); return undefined; }
      throw err;
    }
    this.ending = true;
    for (const w of this._waiting.splice(0)) w.reject(new Error('Pool is ending'));
    for (const { timer } of this._idle) clearTimeout(timer);
    this._idle = [];
    await Promise.allSettled([...this._clients].map(c => c.end()));
    this._clients.clear();
    this.ended = true;
    if (callback) callback();
    return undefined;
  }
}

module.exports = { Pool, Client, types, DatabaseError, defaults: {}, native: null,
  _internals: { serializeParam, parseTimestamp, parseArray, parseBytea, Scram } };
