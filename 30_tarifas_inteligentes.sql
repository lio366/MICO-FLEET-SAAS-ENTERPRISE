
CREATE TABLE IF NOT EXISTS tarifas_ruta (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  origen VARCHAR(120) NOT NULL,
  destino VARCHAR(120) NOT NULL,
  millas NUMERIC(8,1) NOT NULL,
  tarifa NUMERIC(10,2) NOT NULL,        -- lo que pagó el shipper
  pagado_chofer NUMERIC(10,2) NOT NULL, -- lo que recibió el camionero
  fecha DATE NOT NULL,
  diesel_precio NUMERIC(5,2)
);
CREATE INDEX IF NOT EXISTS idx_tarifas_ruta ON tarifas_ruta(tenant_id, origen, destino, fecha);
