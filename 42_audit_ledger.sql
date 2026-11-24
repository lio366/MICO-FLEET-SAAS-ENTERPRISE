
CREATE TABLE IF NOT EXISTS audit_ledger (
  seq BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  actor VARCHAR(60) NOT NULL,
  accion VARCHAR(80) NOT NULL,
  entidad VARCHAR(40) NOT NULL,
  entidad_id VARCHAR(40) NOT NULL,
  antes JSONB,
  despues JSONB,
  motivo TEXT,
  request_id VARCHAR(40),
  dedup_key VARCHAR(80),
  event_fingerprint VARCHAR(64) NOT NULL,  -- identidad del contenido (anti D2) — VARCHAR: CHAR(64) rellena con espacios y rompe la verificación
  occurred_at TIMESTAMPTZ NOT NULL,     -- timestamp EXACTO usado en el hash (anti D1)
  serialization VARCHAR(16) NOT NULL DEFAULT 'rfc8785',
  hash_previo VARCHAR(64) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  creado_en TIMESTAMPTZ DEFAULT now()    -- metadato de ingreso; NO entra en el hash
);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON audit_ledger(tenant_id, entidad, entidad_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tiempo ON audit_ledger(occurred_at);

-- ANTI-FORK REAL
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_hash_previo
  ON audit_ledger(tenant_id, hash_previo);

-- IDEMPOTENCIA REAL (dedup verificable por fingerprint)
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_dedup
  ON audit_ledger(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;

-- INMUTABILIDAD REAL: la app no puede UPDATE/DELETE (corrección = asiento compensatorio)
CREATE OR REPLACE FUNCTION audit_ledger_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LEDGER_INMUTABLE: las correcciones se registran como asiento compensatorio (INSERT), nunca UPDATE/DELETE';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_ledger_no_update ON audit_ledger;
CREATE TRIGGER trg_ledger_no_update BEFORE UPDATE OR DELETE ON audit_ledger
  FOR EACH ROW EXECUTE FUNCTION audit_ledger_inmutable();

-- CHECKPOINTS EXTERNOS FIRMADOS (HMAC-SHA256 o Ed25519; la clave vive FUERA de la BD)
CREATE TABLE IF NOT EXISTS audit_checkpoints (
  tenant_id UUID NOT NULL,
  seq BIGINT NOT NULL,
  hash VARCHAR(64) NOT NULL,
  firma VARCHAR(128) NOT NULL,           -- hex HMAC(64) o firma Ed25519(128)
  firma_alg VARCHAR(16) NOT NULL DEFAULT 'hmac-sha256',
  firmado_en TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, seq)
);
