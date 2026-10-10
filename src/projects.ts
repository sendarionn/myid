import { type Db, type Tx, withTransaction } from './db.ts';
import { badRequest, forbidden, isUuid, notFound } from './http.ts';

export const PERMISSIONS = [
  'project.view',
  'project.edit',
  'details.view',
  'details.edit',
  'contract.view',
  'contract.edit',
  'events.view',
  'members.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['customer', 'contractor', 'installer', 'maintainer', 'other'] as const;
export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'] as const;
export const WORK_TYPES = ['site_survey', 'installation', 'maintenance'] as const;
export const BILLING_STATUSES = ['not_billed', 'billed', 'paid'] as const;

// 編集権限は対応する閲覧権限を含む
const IMPLIED: Partial<Record<Permission, Permission>> = {
  'project.edit': 'project.view',
  'details.edit': 'details.view',
  'contract.edit': 'contract.view',
};

export type Access = {
  projectId: string;
  membershipId: string;
  role: string;
  permissions: Set<Permission>;
};

export function oneOf<T extends string>(values: readonly T[], value: unknown): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw badRequest();
  return value as T;
}

export function parsePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value) || value.length > PERMISSIONS.length) throw badRequest();
  const set = new Set(value.map((v) => oneOf(PERMISSIONS, v)));
  for (const p of [...set]) {
    const implied = IMPLIED[p];
    if (implied) set.add(implied);
  }
  return PERMISSIONS.filter((p) => set.has(p));
}

export function parseName(value: unknown): string {
  if (typeof value !== 'string') throw badRequest();
  const name = value.trim();
  if (name.length < 1 || name.length > 100) throw badRequest();
  return name;
}

// 'share': 通常の読み書き
// 'update': 案件行・参加関係の変更（参加者変更を案件単位で直列化する）
export type LockMode = 'share' | 'update';

// 案件へのアクセスはすべてここを通す
// 権限変更と同じトランザクション境界で判定するため、失効は次のリクエストから即時に反映される
export async function withProject<T>(
  db: Db,
  rawProjectId: unknown,
  userId: string,
  opts: { permission?: Permission; lock?: LockMode },
  fn: (tx: Tx, access: Access) => Promise<T>,
): Promise<T> {
  // 不正なID・存在しない案件・非参加者はすべて同じ404
  if (!isUuid(rawProjectId)) throw notFound();
  const projectId = rawProjectId;
  return withTransaction(db, async (tx) => {
    const lock = opts.lock === 'update' ? 'FOR UPDATE' : 'FOR SHARE';
    const project = await tx.query(`SELECT 1 FROM projects WHERE id = $1 ${lock}`, [projectId]);
    if (!project.rowCount) throw notFound();
    const { rows } = await tx.query<{ id: string; role: string; permissions: Permission[] }>(
      `SELECT m.id, m.role,
              coalesce(array_agg(p.permission::text) FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
       FROM project_memberships m
       LEFT JOIN project_permissions p ON p.membership_id = m.id
       WHERE m.project_id = $1 AND m.user_id = $2 AND m.status = 'active'
         AND (m.valid_until IS NULL OR m.valid_until > now())
       GROUP BY m.id`,
      [projectId, userId],
    );
    const m = rows[0];
    if (!m) throw notFound();
    const access: Access = { projectId, membershipId: m.id, role: m.role, permissions: new Set(m.permissions) };
    if (opts.permission && !access.permissions.has(opts.permission)) throw forbidden();
    return fn(tx, access);
  });
}

export async function recordEvent(
  tx: Tx,
  access: Access,
  eventType: string,
  statusFrom: string | null = null,
  statusTo: string | null = null,
): Promise<void> {
  await tx.query(
    `INSERT INTO project_events (project_id, event_type, actor_membership_id, status_from, status_to)
     VALUES ($1, $2, $3, $4, $5)`,
    [access.projectId, eventType, access.membershipId, statusFrom, statusTo],
  );
}

export async function recordAudit(
  tx: Tx,
  projectId: string,
  action: string,
  fields: {
    actorMembershipId?: string | null;
    targetMembershipId?: string | null;
    invitationId?: string | null;
    role?: string | null;
    permissions?: Permission[] | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO project_audit_log
       (project_id, action, actor_membership_id, target_membership_id, invitation_id, role, permissions)
     VALUES ($1, $2, $3, $4, $5, $6, $7::project_permission[])`,
    [
      projectId,
      action,
      fields.actorMembershipId ?? null,
      fields.targetMembershipId ?? null,
      fields.invitationId ?? null,
      fields.role ?? null,
      fields.permissions ?? null,
    ],
  );
}

export async function grantPermissions(tx: Tx, membershipId: string, permissions: Permission[]): Promise<void> {
  if (!permissions.length) return;
  await tx.query(
    `INSERT INTO project_permissions (membership_id, permission)
     SELECT $1, unnest($2::project_permission[])`,
    [membershipId, permissions],
  );
}
