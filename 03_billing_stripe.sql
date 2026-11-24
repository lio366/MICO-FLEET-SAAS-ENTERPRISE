
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  plan VARCHAR(20) NOT NULL,
  amount_monthly INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',     -- ACTIVE | TRIALING | PAST_DUE | CANCELLED
  estado VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',     -- espejo para el cron del server
  grace_termina TIMESTAMPTZ,                        -- fin del periodo de gracia (mora)
  stripe_subscription_id VARCHAR(60),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  creado_en TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON subscriptions(tenant_id, status);
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  amount INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'SUCCEEDED',
  stripe_invoice_id VARCHAR(60),
  paid_at TIMESTAMPTZ,
  creado_en TIMESTAMPTZ DEFAULT now()
);
