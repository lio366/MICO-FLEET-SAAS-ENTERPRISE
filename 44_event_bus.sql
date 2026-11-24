
-- Bandeja de salida: se escribe junto con el cambio de datos (misma transacción)
CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  tipo VARCHAR(60) NOT NULL,          -- 'carga.ofertada' | 'carga.aceptada' | 'pago.registrado'...
  payload JSONB NOT NULL,
  publicado_en TIMESTAMP,             -- NULL = pendiente de publicar
  creado_en TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_pendiente ON outbox(publicado_en) WHERE publicado_en IS NULL;

-- Consumos idempotentes: cada suscriptor ancla lo que ya procesó
CREATE TABLE IF NOT EXISTS consumos_eventos (
  suscriptor VARCHAR(60) NOT NULL,
  evento_id BIGINT NOT NULL REFERENCES outbox(id),
  procesado_en TIMESTAMP DEFAULT now(),
  PRIMARY KEY (suscriptor, evento_id)
);
