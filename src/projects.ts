import { type Db, type Tx, withTransaction } from './db.ts';
import { badRequest, forbidden, isUuid, notFound } from './http.ts';

// 参加関係の役割
// 顧客は役割や権限を設定できず、案件作成者が manager、招待で参加した人が member になる
export type Role = 'manager' | 'member';

// 案件に対する操作と、それを許可する役割（認可ポリシーはここだけで定義する）
// 新しい案件データを追加するときは、ここに操作を追加して業務ルールに基づいて許可する
const POLICY = {
  'project.view': ['manager', 'member'],
  'project.rename': ['manager'],
  'members.view': ['manager', 'member'],
  'members.remove': ['manager'],
  'invitations.manage': ['manager'],
  'audit.view': ['manager'],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof POLICY;

export function can(role: Role, action: Action): boolean {
  return (POLICY[action] as readonly Role[]).includes(role);
}

export function allowedActions(role: Role): Action[] {
  return (Object.keys(POLICY) as Action[]).filter((a) => can(role, a));
}

export type Access = {
  projectId: string;
  membershipId: string;
  role: Role;
};

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
// 参加関係を毎リクエストDBで確認するため、参加解除は次のリクエストから即時に反映される
export async function withProject<T>(
  db: Db,
  rawProjectId: unknown,
  userId: string,
  opts: { action: Action; lock?: LockMode },
  fn: (tx: Tx, access: Access) => Promise<T>,
): Promise<T> {
  // 不正なID・存在しない案件・非参加者はすべて同じ404
  if (!isUuid(rawProjectId)) throw notFound();
  const projectId = rawProjectId;
  return withTransaction(db, async (tx) => {
    const lock = opts.lock === 'update' ? 'FOR UPDATE' : 'FOR SHARE';
    const project = await tx.query(`SELECT 1 FROM projects WHERE id = $1 ${lock}`, [projectId]);
    if (!project.rowCount) throw notFound();
    const { rows } = await tx.query<{ id: string; role: Role }>(
      'SELECT id, role FROM project_memberships WHERE project_id = $1 AND user_id = $2',
      [projectId, userId],
    );
    const m = rows[0];
    if (!m) throw notFound();
    const access: Access = { projectId, membershipId: m.id, role: m.role };
    if (!can(access.role, opts.action)) throw forbidden();
    return fn(tx, access);
  });
}

export async function recordAudit(
  tx: Tx,
  projectId: string,
  action: string,
  fields: {
    actorMembershipId?: string | null;
    targetMembershipId?: string | null;
    invitationId?: string | null;
    memberRole?: Role | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO project_audit_log
       (project_id, action, actor_membership_id, target_membership_id, invitation_id, member_role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      projectId,
      action,
      fields.actorMembershipId ?? null,
      fields.targetMembershipId ?? null,
      fields.invitationId ?? null,
      fields.memberRole ?? null,
    ],
  );
}
