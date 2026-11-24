
CREATE TABLE IF NOT EXISTS cluster_nodos (
  id VARCHAR(60) PRIMARY KEY,             -- hostname-pid
  lider BOOLEAN DEFAULT FALSE,
  ultimo_heartbeat TIMESTAMP DEFAULT now(),
  iniciado_en TIMESTAMP DEFAULT now()
);
