-- MVPへの簡素化
-- 参加者ごとの任意の権限付与をやめ、参加関係の役割（manager / member）とサーバー側のポリシーで認可する
-- 製品・作業予定・契約・案件イベント・案件ステータス・承認制・参加の有効期限を廃止する
-- 適用したDBでは、これらのデータは失われる（監査ログの過去の行は残す）

-- 以降のDMLで既存の遅延トリガーを即時に実行し、旧テーブルを削除する前に検査を済ませる
SET CONSTRAINTS ALL IMMEDIATE;

-- ===== 参加関係の整理 =====

-- 承認されていない参加は有効化しない
DELETE FROM project_memberships WHERE status = 'pending_approval';

-- 有効期限の列を廃止すると無期限の参加になるため、期限付き（期限切れを含む）の参加は削除する
DELETE FROM project_memberships WHERE valid_until IS NOT NULL;

CREATE TYPE membership_role AS ENUM ('manager', 'member');

ALTER TABLE project_memberships ADD COLUMN access_role membership_role;

-- members.manage を持っていた参加者を管理者、それ以外を一般参加者にする
UPDATE project_memberships m
SET access_role = CASE
  WHEN EXISTS (
    SELECT 1 FROM project_permissions p WHERE p.membership_id = m.id AND p.permission = 'members.manage'
  ) THEN 'manager'::membership_role
  ELSE 'member'::membership_role
END;

-- ===== 権限テーブルに依存するトリガーの削除 =====

DROP TRIGGER project_permissions_require_manager ON project_permissions;
DROP TRIGGER project_permissions_revoke_invitations ON project_permissions;
DROP FUNCTION check_project_manager_from_permission();
DROP FUNCTION revoke_invitations_on_manager_permission_delete();

DROP TABLE project_invitation_permissions;
DROP TABLE project_permissions;

ALTER TABLE project_memberships
  DROP COLUMN role,
  DROP COLUMN status,
  DROP COLUMN valid_until;
ALTER TABLE project_memberships RENAME COLUMN access_role TO role;
ALTER TABLE project_memberships ALTER COLUMN role SET NOT NULL;
DROP TYPE membership_status;

CREATE INDEX project_memberships_managers_idx ON project_memberships (project_id) WHERE role = 'manager';

-- 案件には管理者が1人以上いる（既存の遅延制約トリガーから呼ばれる）
CREATE OR REPLACE FUNCTION assert_project_has_manager(p_project_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM project_memberships WHERE project_id = p_project_id AND role = 'manager'
  ) THEN
    RAISE EXCEPTION 'project must keep at least one manager' USING ERRCODE = 'MI001';
  END IF;
END;
$$;

-- ===== 招待 =====

-- 招待で参加した人は常に一般参加者になる
ALTER TABLE project_invitations
  DROP COLUMN role,
  DROP COLUMN requires_approval;

-- ===== 業務データの廃止 =====

DROP TABLE project_products;
DROP TABLE project_work_schedules;
DROP TABLE project_contracts;
DROP TABLE project_events;
DROP TYPE work_type;
DROP TYPE billing_status;
DROP TYPE project_event_type;

ALTER TABLE projects DROP COLUMN status;
DROP TYPE project_status;

-- ===== 監査ログ =====

-- role（project_role）と permissions は003より前の記録だけが持つ
-- 003以降は member_role に参加時の役割を記録する
ALTER TABLE project_audit_log ADD COLUMN member_role membership_role;
ALTER TYPE project_audit_action ADD VALUE 'project_created';
ALTER TYPE project_audit_action ADD VALUE 'project_renamed';
