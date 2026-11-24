
CREATE TABLE IF NOT EXISTS scores_confianza (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  tipo VARCHAR(10) NOT NULL,            -- 'shipper' | 'chofer'
  tercero_id VARCHAR(80) NOT NULL,      -- MC number o id del cliente
  nombre VARCHAR(160),
  puntos INT NOT NULL DEFAULT 70,
  nota VARCHAR(1) GENERATED ALWAYS AS (
    CASE WHEN puntos >= 90 THEN 'A' WHEN puntos >= 75 THEN 'B'
         WHEN puntos >= 55 THEN 'C' WHEN puntos >= 30 THEN 'D' ELSE 'E' END
  ) STORED,
  cargas_completadas INT DEFAULT 0,
  incumplimientos INT DEFAULT 0,
  dias_promedio_pago NUMERIC(5,1),
  actualizado_en TIMESTAMP DEFAULT now(),
  UNIQUE(tenant_id, tipo, tercero_id)
);
