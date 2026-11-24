
CREATE TABLE IF NOT EXISTS sesiones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL,
  rol VARCHAR(12) NOT NULL,              -- ADMIN|DISPATCHER|VIEWER|DRIVER
  token_hash VARCHAR(64) NOT NULL,       -- sha256 del JWT (nunca el token en claro)
  revocada BOOLEAN DEFAULT FALSE,
  ip VARCHAR(45), user_agent TEXT,
  creada_en TIMESTAMP DEFAULT now(),
  expira_en TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sesiones_user ON sesiones(user_id, revocada);

-- Tablas que el login exige (faltaban en el módulo; antes fallaría en PG real)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  nombre VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  rol VARCHAR(12) NOT NULL DEFAULT 'DISPATCHER',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_intentos (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(160) NOT NULL,
  exito BOOLEAN NOT NULL,
  intento_en TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_intentos ON login_intentos(email, intento_en);
