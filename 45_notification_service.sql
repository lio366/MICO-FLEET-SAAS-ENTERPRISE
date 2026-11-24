
CREATE TABLE IF NOT EXISTS notificaciones_enviadas (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  destinatario VARCHAR(20) NOT NULL,    -- 'driver:uuid' | 'admin' | 'shipper:mc'
  canal VARCHAR(10) NOT NULL,           -- push|sms|whatsapp|voz|email
  tipo VARCHAR(40) NOT NULL,
  texto TEXT NOT NULL,
  entregado BOOLEAN,
  error TEXT,
  creado_en TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_dest ON notificaciones_enviadas(destinatario, creado_en);
