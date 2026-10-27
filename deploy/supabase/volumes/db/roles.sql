-- Copia recortada de supabase/supabase docker/volumes/db/roles.sql, tag self-hosted/v0.8.3
-- (commit bc27d2661edd09a5d0b8d76ce33da6d4071a756e). Valmont (T-100) quita la línea de
-- supabase_functions_admin: en supabase/postgres 17.6.1.136 ese rol solo lo crea el event trigger
-- issue_pg_net_access al instalar pg_net, cosa que hace webhooks.sql, que este stack no monta (pg_net
-- permitiría HTTP saliente desde la BD). Sin el rol, el ALTER USER abortaría la inicialización
-- (ON_ERROR_STOP) y dejaría la BD a medias. El resto de roles los crea la propia imagen: pgbouncer
-- (init-scripts/00-schema.sql), authenticator, supabase_auth_admin y supabase_storage_admin.
-- NOTE: change to your own passwords for production environments
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
