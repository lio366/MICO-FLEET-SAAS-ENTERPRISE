-- Bootstrap exclusivo para PostgreSQL nuevo (docker-entrypoint-initdb.d).
-- El usuario bootstrap administra el esquema; la app se conecta como mf_login.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mf_owner') THEN
    CREATE ROLE mf_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mf_app') THEN
    CREATE ROLE mf_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mf_readonly') THEN
    CREATE ROLE mf_readonly NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mf_login') THEN
    CREATE ROLE mf_login LOGIN;
  END IF;
END $$;
GRANT mf_app TO mf_login;
GRANT USAGE, CREATE ON SCHEMA public TO mf_owner;
GRANT USAGE ON SCHEMA public TO mf_app, mf_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE mf_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mf_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mf_app;
