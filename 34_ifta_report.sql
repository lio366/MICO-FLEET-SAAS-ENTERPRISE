
CREATE TABLE IF NOT EXISTS gps_points (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  driver_id UUID NOT NULL REFERENCES drivers(id),
  booking_id UUID REFERENCES bookings(id),
  pos GEOGRAPHY(POINT,4326) NOT NULL,
  velocidad_mph NUMERIC(5,1),
  grabado_en TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gps_points_tiempo ON gps_points(tenant_id, driver_id, grabado_en);

-- Cache de tasas IFTA por estado/año/trimestre (se cargan 1 vez por trimestre)
CREATE TABLE IF NOT EXISTS ifta_tasas (
  estado CHAR(2) PRIMARY KEY,
  anio INT,
  trimestre INT,
  tasa_por_galon NUMERIC(6,4) NOT NULL  -- ej. 0.4949 Florida 2026 T1
);
