
CREATE TABLE IF NOT EXISTS verificaciones_carrier (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  driver_id UUID NOT NULL REFERENCES drivers(id),
  mc_numero VARCHAR(20),
  dot_numero VARCHAR(20),
  -- CAPA 1: registro federal
  fmcsa_autoridad_activa BOOLEAN DEFAULT false,
  fmcsa_seguro_vigente BOOLEAN DEFAULT false,
  fmcsa_verificado_en TIMESTAMP,
  -- CAPA 2: aseguradora
  aseguradora VARCHAR(160),
  poliza_auto_liability VARCHAR(60),
  poliza_cargo VARCHAR(60),
  poliza_verificada BOOLEAN DEFAULT false,      -- confirmada por llamada
  poliza_verificada_en TIMESTAMP,
  poliza_verificada_por VARCHAR(40),            -- 'agente_voz' | 'manual'
  -- CAPA 4: evidencia física
  foto_cdl_url TEXT,
  foto_camion_url TEXT,
  foto_poliza_url TEXT,
  cdl_nombre VARCHAR(160),
  cdl_coincide_mc BOOLEAN,                      -- nombre CDL vs titular del MC
  evidencia_completa BOOLEAN GENERATED ALWAYS AS (
    foto_cdl_url IS NOT NULL AND foto_camion_url IS NOT NULL AND foto_poliza_url IS NOT NULL
  ) STORED,
  -- VEREDICTO
  estado VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE', -- PENDIENTE|VERIFICADO|BLOQUEADO
  motivo_bloqueo TEXT,
  actualizado_en TIMESTAMP DEFAULT now(),
  UNIQUE(tenant_id, driver_id)
);
