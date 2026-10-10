-- 匿名Passkey認証・案件共有PoCの初期スキーマ
-- 日時はすべて timestamptz（UTC保存）

-- ===== 認証 =====

CREATE TABLE auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- WebAuthnのuser.id（userHandle）
  -- 内部IDとは別のランダム値にして、認証器側の値と業務データを直接結合させない
  webauthn_user_handle bytea NOT NULL UNIQUE CHECK (octet_length(webauthn_user_handle) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE credential_device_type AS ENUM ('singleDevice', 'multiDevice');

CREATE TABLE passkey_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE
    CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND char_length(credential_id) BETWEEN 16 AND 1366),
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 1 AND 2048),
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
  transports text[] NOT NULL DEFAULT '{}'
    CHECK (transports <@ ARRAY['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']::text[]),
  device_type credential_device_type NOT NULL,
  backed_up boolean NOT NULL,
  aaguid uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX passkey_credentials_user_id_idx ON passkey_credentials (user_id);

-- 最後のPasskeyの削除を防ぐ
-- アカウント削除（auth_usersからのCASCADE）の場合はユーザー行が既に消えているため許可する
CREATE FUNCTION prevent_last_passkey_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 同一ユーザーのPasskey削除を直列化する
  PERFORM 1 FROM auth_users WHERE id = OLD.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM passkey_credentials WHERE user_id = OLD.user_id AND id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'last passkey cannot be deleted' USING ERRCODE = 'MI002';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER passkey_credentials_prevent_last_delete
  BEFORE DELETE ON passkey_credentials
  FOR EACH ROW EXECUTE FUNCTION prevent_last_passkey_delete();

-- express-session（connect-pg-simple）のサーバー側セッション
-- user_id はセッション内容から生成し、ユーザー削除時にDBレベルでセッションを失効させる
CREATE TABLE sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess jsonb NOT NULL,
  expire timestamptz NOT NULL,
  user_id uuid GENERATED ALWAYS AS ((sess ->> 'uid')::uuid) STORED
    REFERENCES auth_users (id) ON DELETE CASCADE
);

CREATE INDEX sessions_expire_idx ON sessions (expire);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TYPE webauthn_ceremony AS ENUM (
  'registration',
  'authentication',
  'reauthentication',
  'passkey_addition'
);

-- WebAuthn Challenge
-- セッションIDそのものではなくハッシュに紐付け、取得と同時に削除して一回限りとする
CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash bytea NOT NULL CHECK (octet_length(session_hash) = 32),
  ceremony webauthn_ceremony NOT NULL,
  challenge text NOT NULL UNIQUE CHECK (challenge ~ '^[A-Za-z0-9_-]{43,}$'),
  user_id uuid REFERENCES auth_users (id) ON DELETE CASCADE,
  pending_user_handle bytea CHECK (octet_length(pending_user_handle) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (session_hash, ceremony),
  CHECK (expires_at > created_at),
  CHECK ((ceremony = 'registration') = (pending_user_handle IS NOT NULL)),
  CHECK ((ceremony IN ('reauthentication', 'passkey_addition')) = (user_id IS NOT NULL))
);

CREATE INDEX webauthn_challenges_expires_at_idx ON webauthn_challenges (expires_at);

-- ===== 案件 =====

CREATE TYPE project_status AS ENUM ('planning', 'active', 'on_hold', 'completed', 'cancelled');

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  status project_status NOT NULL DEFAULT 'planning',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 役割は案件内での立場を表すラベルで、認可には使わない
CREATE TYPE project_role AS ENUM ('customer', 'contractor', 'installer', 'maintainer', 'other');

-- 認可は明示的に付与された権限だけで判定する
CREATE TYPE project_permission AS ENUM (
  'project.view',
  'project.edit',
  'details.view',
  'details.edit',
  'contract.view',
  'contract.edit',
  'events.view',
  'members.manage'
);

CREATE TYPE membership_status AS ENUM ('pending_approval', 'active');

-- 失効した参加関係は行ごと削除し、履歴は project_audit_log に残す
CREATE TABLE project_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  role project_role NOT NULL,
  status membership_status NOT NULL,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id),
  CHECK (valid_until IS NULL OR valid_until > created_at)
);

CREATE INDEX project_memberships_user_id_idx ON project_memberships (user_id);

CREATE TABLE project_permissions (
  membership_id uuid NOT NULL REFERENCES project_memberships (id) ON DELETE CASCADE,
  permission project_permission NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, permission)
);

-- 案件には常に、有効期限のない有効な管理者（members.manage）が1人以上いる
-- コミット時に検査するため、同一トランザクション内の一時的な不在は許容する
CREATE FUNCTION assert_project_has_manager(p_project_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM project_memberships m
    JOIN project_permissions p ON p.membership_id = m.id
    WHERE m.project_id = p_project_id
      AND m.status = 'active'
      AND m.valid_until IS NULL
      AND p.permission = 'members.manage'
  ) THEN
    RAISE EXCEPTION 'project must keep at least one manager' USING ERRCODE = 'MI001';
  END IF;
END;
$$;

CREATE FUNCTION check_project_manager_from_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_project_has_manager(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION check_project_manager_from_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'membership project cannot change';
  END IF;
  PERFORM assert_project_has_manager(OLD.project_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION check_project_manager_from_permission() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_project_id uuid;
BEGIN
  SELECT project_id INTO v_project_id FROM project_memberships WHERE id = OLD.membership_id;
  IF FOUND THEN
    PERFORM assert_project_has_manager(v_project_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER projects_require_manager
  AFTER INSERT ON projects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_project_manager_from_project();

CREATE CONSTRAINT TRIGGER project_memberships_require_manager
  AFTER UPDATE OR DELETE ON project_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_project_manager_from_membership();

CREATE CONSTRAINT TRIGGER project_permissions_require_manager
  AFTER UPDATE OR DELETE ON project_permissions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_project_manager_from_permission();

-- ===== 招待 =====

CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'revoked');

-- トークンはSHA-256ハッシュのみ保存する
-- 期限切れは status ではなく expires_at で判定する
CREATE TABLE project_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  role project_role NOT NULL,
  requires_approval boolean NOT NULL DEFAULT false,
  status invitation_status NOT NULL DEFAULT 'pending',
  created_by_membership_id uuid REFERENCES project_memberships (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX project_invitations_project_id_idx ON project_invitations (project_id);

-- 参加関係の削除や members.manage の剥奪時に、その参加者が作成した未使用の招待を失効させる
CREATE FUNCTION revoke_invitations_created_by(p_membership_id uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE project_invitations
  SET status = 'revoked', revoked_at = now()
  WHERE created_by_membership_id = p_membership_id AND status = 'pending';
$$;

CREATE FUNCTION revoke_invitations_on_membership_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM revoke_invitations_created_by(OLD.id);
  RETURN OLD;
END;
$$;

CREATE FUNCTION revoke_invitations_on_manager_permission_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.permission = 'members.manage' THEN
    PERFORM revoke_invitations_created_by(OLD.membership_id);
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER project_memberships_revoke_invitations
  BEFORE DELETE ON project_memberships
  FOR EACH ROW EXECUTE FUNCTION revoke_invitations_on_membership_delete();

CREATE TRIGGER project_permissions_revoke_invitations
  BEFORE DELETE ON project_permissions
  FOR EACH ROW EXECUTE FUNCTION revoke_invitations_on_manager_permission_delete();

CREATE TABLE project_invitation_permissions (
  invitation_id uuid NOT NULL REFERENCES project_invitations (id) ON DELETE CASCADE,
  permission project_permission NOT NULL,
  PRIMARY KEY (invitation_id, permission)
);

-- ===== 案件情報（ダミーの構造化データ） =====

CREATE TABLE project_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  product_code text NOT NULL CHECK (product_code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_products_project_id_idx ON project_products (project_id);

CREATE TYPE work_type AS ENUM ('site_survey', 'installation', 'maintenance');

CREATE TABLE project_work_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  work_type work_type NOT NULL,
  scheduled_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_work_schedules_project_id_idx ON project_work_schedules (project_id);

CREATE TYPE billing_status AS ENUM ('not_billed', 'billed', 'paid');

-- 閲覧権限が限定される情報
CREATE TABLE project_contracts (
  project_id uuid PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  contract_reference text NOT NULL CHECK (contract_reference ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  amount_jpy bigint NOT NULL CHECK (amount_jpy BETWEEN 0 AND 1000000000000),
  billing_status billing_status NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== 履歴 =====

CREATE TYPE project_event_type AS ENUM (
  'project_created',
  'project_renamed',
  'status_changed',
  'product_added',
  'schedule_added',
  'contract_updated'
);

-- 案件の業務イベント（events.view で閲覧）
-- 実行者は参加関係IDで記録し、案件をまたいでユーザーを結合できないようにする
CREATE TABLE project_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 同一トランザクション内でも記録順に並べるための連番（外部には意味を持たせない）
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  event_type project_event_type NOT NULL,
  actor_membership_id uuid,
  status_from project_status,
  status_to project_status,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_type = 'status_changed') = (status_from IS NOT NULL AND status_to IS NOT NULL)),
  CHECK (event_type = 'status_changed' OR (status_from IS NULL AND status_to IS NULL))
);

CREATE INDEX project_events_project_id_idx ON project_events (project_id, seq);

CREATE TYPE project_audit_action AS ENUM (
  'member_added',
  'member_approved',
  'member_updated',
  'member_revoked',
  'member_left',
  'invitation_created',
  'invitation_revoked'
);

-- 参加者・権限・招待の変更履歴（members.manage で閲覧）
-- 招待トークンなどの機密値は記録しない
CREATE TABLE project_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  action project_audit_action NOT NULL,
  actor_membership_id uuid,
  target_membership_id uuid,
  invitation_id uuid,
  role project_role,
  permissions project_permission[],
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_audit_log_project_id_idx ON project_audit_log (project_id, seq);
