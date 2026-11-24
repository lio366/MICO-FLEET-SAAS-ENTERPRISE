
CREATE TABLE IF NOT EXISTS geo_cache (
  key VARCHAR(160) PRIMARY KEY,          -- 'miami,fl'
  lat NUMERIC(9,5) NOT NULL,
  lon NUMERIC(9,5) NOT NULL,
  timezone VARCHAR(60) NOT NULL,         -- 'America/New_York'
  display VARCHAR(200),
  consultado_en TIMESTAMP DEFAULT now()
);
