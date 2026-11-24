
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_owner') THEN
    CREATE ROLE mf_owner NOLOGIN;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_app') THEN
    CREATE ROLE mf_app NOLOGIN;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mf_readonly') THEN
    CREATE ROLE mf_readonly NOLOGIN;
  END IF;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO mf_owner;
ALTER TABLE audit_ledger OWNER TO mf_owner;
ALTER TABLE audit_checkpoints OWNER TO mf_owner;
-- ALTER TABLE ... OWNER transfiere también la secuencia BIGSERIAL de seq (audit_ledger_seq_seq).
GRANT USAGE ON SCHEMA public TO mf_app, mf_readonly;
GRANT SELECT, INSERT ON audit_ledger, audit_checkpoints TO mf_app;
DO $$ BEGIN
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO mf_app',
                 pg_get_serial_sequence('public.audit_ledger', 'seq'));
END $$;
GRANT SELECT ON audit_ledger, audit_checkpoints TO mf_readonly;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_ledger, audit_checkpoints FROM mf_app;
