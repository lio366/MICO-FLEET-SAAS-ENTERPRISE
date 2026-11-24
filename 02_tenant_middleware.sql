
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(60) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  custom_domain VARCHAR(120) UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'TRIAL',      -- TRIAL | ACTIVE | PAST_DUE | SUSPENDED | CANCELLED
  plan VARCHAR(20),                                  -- starter | pro | enterprise
  max_trucks INT NOT NULL DEFAULT 5,
  max_users INT NOT NULL DEFAULT 3,
  stripe_customer_id VARCHAR(60),
  trial_ends_at TIMESTAMPTZ,
  creado_en TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenants_estado ON tenants(status);
