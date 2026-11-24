-- Privilegios funcionales y RLS para tablas de negocio con tenant_id.
-- Ejecutar después de crear las tablas y antes del SQL_ROLES del ledger.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mf_app') THEN CREATE ROLE mf_app NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO mf_app;
-- CRUD para tablas de negocio. Las tablas de auditoría y de control de esquema se excluyen
-- de forma explícita: su privilegio mínimo (SELECT, INSERT) lo define SQL_ROLES del ledger,
-- y este script puede reejecutarse sin devolver UPDATE/DELETE sobre el ledger a mf_app.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname='public'
      AND tablename NOT IN ('audit_ledger','audit_checkpoints','schema_migrations')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO mf_app', r.tablename);
  END LOOP;
  IF to_regclass('public.audit_ledger') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_ledger FROM mf_app;
  END IF;
  IF to_regclass('public.audit_checkpoints') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_checkpoints FROM mf_app;
  END IF;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mf_app;
DO $$ BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE schema_migrations FROM mf_app;
  END IF;
END $$;

DO $$
DECLARE r RECORD;
BEGIN
  -- La tabla tenants se consulta antes de conocer el contexto del tenant;
  -- su resolución requiere endurecimiento separado con función SECURITY DEFINER.
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='public' AND c.column_name='tenant_id'
      AND t.table_type='BASE TABLE' AND c.table_name <> 'tenants'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I USING (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      r.table_name
    );
  END LOOP;
END $$;
