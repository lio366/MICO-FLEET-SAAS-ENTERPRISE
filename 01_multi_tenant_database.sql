-- ============================================================
-- MICRO-FLEET SAAS ENTERPRISE v3.0 — Multi-Tenant Database
-- Cada broker es un "tenant" (inquilino) aislado de los demás
-- ============================================================

-- Tabla central: los brokers que pagan la renta mensual
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,                  -- Nombre del broker
    slug VARCHAR(100) UNIQUE NOT NULL,           -- Subdominio: broker.tuapp.com
    plan VARCHAR(50) NOT NULL DEFAULT 'STARTER', -- STARTER / PRO / ENTERPRISE
    status VARCHAR(50) NOT NULL DEFAULT 'TRIAL', -- TRIAL / ACTIVE / SUSPENDED / CANCELLED
    trial_ends_at TIMESTAMPTZ,
    max_trucks INT NOT NULL DEFAULT 10,          -- Límite de camiones según plan
    max_users INT NOT NULL DEFAULT 3,
    custom_domain VARCHAR(255),                  -- white-label: dispatch.mibroker.com
    logo_url TEXT,
    brand_color VARCHAR(7) DEFAULT '#3B82F6',    -- Color de su marca
    stripe_customer_id VARCHAR(255),             -- Cliente en Stripe (cobros)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Usuarios de cada broker (el broker y sus despachadores)
CREATE TABLE tenant_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'DISPATCHER', -- ADMIN / DISPATCHER / VIEWER
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tenant_users_tenant ON tenant_users(tenant_id);

-- Suscripciones y facturación mensual
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan VARCHAR(50) NOT NULL,
    amount_monthly DECIMAL(10,2) NOT NULL,       -- 299 / 799 / 1999
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',-- ACTIVE / PAST_DUE / CANCELLED
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_subscriptions_tenant ON subscriptions(tenant_id);

-- Registro de pagos (auditoría financiera)
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES subscriptions(id),
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    status VARCHAR(50) NOT NULL,                 -- SUCCEEDED / FAILED / REFUNDED
    stripe_invoice_id VARCHAR(255),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_payments_tenant ON payments(tenant_id);

-- CAMBIO CLAVE: todas las tablas del negocio ahora llevan tenant_id
-- Cada dato queda etiquetado a qué broker pertenece
CREATE TABLE drivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(255),
    truck_number VARCHAR(50),
    current_lat DECIMAL(10,7),
    current_lng DECIMAL(10,7),
    hos_status VARCHAR(50) DEFAULT 'ON_DUTY',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_drivers_tenant ON drivers(tenant_id);

CREATE TABLE loads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    external_id VARCHAR(255),                    -- ID en DAT/Truckstop
    source VARCHAR(50),                          -- DAT / TRUCKSTOP
    origin_city VARCHAR(255),
    origin_state VARCHAR(2),
    origin_lat DECIMAL(10,7),
    origin_lng DECIMAL(10,7),
    dest_city VARCHAR(255),
    dest_state VARCHAR(2),
    dest_lat DECIMAL(10,7),
    dest_lng DECIMAL(10,7),
    miles DECIMAL(10,2),
    rate DECIMAL(10,2),
    rpm DECIMAL(6,2),                            -- rate per mile
    equipment VARCHAR(50),
    pickup_at TIMESTAMPTZ,
    status VARCHAR(50) DEFAULT 'AVAILABLE',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_loads_tenant ON loads(tenant_id);
CREATE INDEX idx_loads_status ON loads(status) WHERE status = 'AVAILABLE';

CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    load_id UUID REFERENCES loads(id),
    driver_id UUID REFERENCES drivers(id),
    status VARCHAR(50) DEFAULT 'CONFIRMED',
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
);
CREATE INDEX idx_bookings_tenant ON bookings(tenant_id);

-- Uso mensual por tenant (para límites del plan y reportes)
CREATE TABLE tenant_usage (
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    month CHAR(7) NOT NULL,                      -- '2026-11'
    loads_matched INT DEFAULT 0,
    bookings_created INT DEFAULT 0,
    api_calls INT DEFAULT 0,
    PRIMARY KEY (tenant_id, month)
);

-- Muestras de entrenamiento para la red neuronal (archivo 15)
-- Cada aceptación/rechazo queda guardado y la red se reentrena sola
CREATE TABLE training_samples (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    features JSONB NOT NULL,          -- las 18 señales de la carga + contexto
    label INT NOT NULL,               -- 1 = aceptó, 0 = rechazó
    trained_at TIMESTAMPTZ,           -- cuándo la red ya usó esta muestra
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_training_tenant ON training_samples (tenant_id, trained_at);

-- Reportes IRS trimestrales (módulo 22)
CREATE TABLE irs_reports (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    anio INT NOT NULL,
    trimestre INT NOT NULL,
    contenido TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (tenant_id, anio, trimestre)
);

-- Configuración modo familia (módulo 21) — se agregan a la tabla drivers
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS familia_nombre VARCHAR(255);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS familia_telefono VARCHAR(20);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS familia_cada_minutos INT DEFAULT 30;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS familia_ultimo_envio TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS familia_activo BOOLEAN DEFAULT FALSE;

-- Conexión QuickBooks del broker (módulo 18)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS qb_realm_id VARCHAR(255);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS qb_access_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS qb_refresh_token TEXT;

-- Aislamiento total: función de seguridad a nivel de fila (RLS)
-- Ningún broker puede ver los datos de otro, ni por error ni por ataque
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE irs_reports ENABLE ROW LEVEL SECURITY;

-- FORCE impide que el propietario ordinario de tablas omita RLS. Superusuarios
-- y roles BYPASSRLS siguen siendo privilegiados y no deben usarse en la app.
ALTER TABLE tenant_users FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE drivers FORCE ROW LEVEL SECURITY;
ALTER TABLE loads FORCE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE training_samples FORCE ROW LEVEL SECURITY;
ALTER TABLE irs_reports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_drivers ON drivers;
CREATE POLICY tenant_isolation_drivers ON drivers
    USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_loads ON loads;
CREATE POLICY tenant_isolation_loads ON loads
    USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_bookings ON bookings;
CREATE POLICY tenant_isolation_bookings ON bookings
    USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
