#!/bin/sh
# PostgreSQL 初回起動時に実行される（docker-entrypoint-initdb.d）
# マイグレーション用の所有者ロールと、DML権限だけを持つアプリ用ロールを分ける
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$MYID_OWNER_PASSWORD" -v app_pw="$MYID_APP_PASSWORD" <<'SQL'
CREATE ROLE myid_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE myid_app LOGIN PASSWORD :'app_pw';
REVOKE ALL ON DATABASE myid FROM PUBLIC;
GRANT CONNECT ON DATABASE myid TO myid_owner, myid_app;
ALTER SCHEMA public OWNER TO myid_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO myid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE myid_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO myid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE myid_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE myid_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO myid_app;
-- マイグレーション履歴はアプリから変更できないようにする（定義は src/migrate.ts と同じ）
SET ROLE myid_owner;
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM myid_app;
RESET ROLE;
SQL
