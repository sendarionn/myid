import type { Db, Tx } from './db.ts';
import { withTransaction } from './db.ts';
import { conflict } from './http.ts';

export type DeletionPlan = {
  // 他の参加者がいるのに自分が唯一の管理者である案件（削除不可の原因）
  blockingProjectIds: string[];
  // 自分以外に有効な参加者がいないため、アカウントと一緒に削除される案件
  projectsToDelete: string[];
  // 参加関係だけが削除され、案件は残る
  projectsToLeave: string[];
};

async function buildPlan(q: Db | Tx, userId: string, lock: boolean): Promise<DeletionPlan & { memberships: { project_id: string; membership_id: string }[] }> {
  const { rows } = await q.query<{
    project_id: string;
    membership_id: string;
    is_manager: boolean;
    other_managers: number;
    other_active_members: number;
  }>(
    `SELECT m.project_id,
            m.id AS membership_id,
            (m.status = 'active' AND m.valid_until IS NULL AND EXISTS (
              SELECT 1 FROM project_permissions p WHERE p.membership_id = m.id AND p.permission = 'members.manage'
            )) AS is_manager,
            (SELECT count(*)::int FROM project_memberships o
               JOIN project_permissions op ON op.membership_id = o.id AND op.permission = 'members.manage'
             WHERE o.project_id = m.project_id AND o.id <> m.id AND o.status = 'active' AND o.valid_until IS NULL
            ) AS other_managers,
            (SELECT count(*)::int FROM project_memberships o
             WHERE o.project_id = m.project_id AND o.id <> m.id AND o.status = 'active'
            ) AS other_active_members
     FROM project_memberships m
     WHERE m.user_id = $1
     ORDER BY m.project_id`,
    [userId],
  );
  if (lock) {
    // 参加者変更と同じ順序（案件行→参加関係）でロックする
    for (const r of rows) await q.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [r.project_id]);
  }
  const plan = { blockingProjectIds: [] as string[], projectsToDelete: [] as string[], projectsToLeave: [] as string[] };
  for (const r of rows) {
    if (r.is_manager && r.other_managers === 0) {
      if (r.other_active_members > 0) plan.blockingProjectIds.push(r.project_id);
      else plan.projectsToDelete.push(r.project_id);
    } else {
      plan.projectsToLeave.push(r.project_id);
    }
  }
  return { ...plan, memberships: rows };
}

export async function deletionPlan(db: Db, userId: string): Promise<DeletionPlan> {
  const { blockingProjectIds, projectsToDelete, projectsToLeave } = await buildPlan(db, userId, false);
  return { blockingProjectIds, projectsToDelete, projectsToLeave };
}

// 共有案件は削除しない
// 唯一の管理者として他の参加者がいる案件がある場合は削除を拒否し、先に管理権限を引き継いでもらう
export async function deleteAccount(db: Db, userId: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query('SELECT 1 FROM auth_users WHERE id = $1 FOR UPDATE', [userId]);
    // ロック取得後の状態で再計算する
    await buildPlan(tx, userId, true);
    const plan = await buildPlan(tx, userId, false);
    if (plan.blockingProjectIds.length) throw conflict('sole_manager_of_shared_project');
    for (const projectId of plan.projectsToDelete) {
      await tx.query('DELETE FROM projects WHERE id = $1', [projectId]);
    }
    for (const m of plan.memberships) {
      if (plan.projectsToLeave.includes(m.project_id)) {
        await tx.query(
          `INSERT INTO project_audit_log (project_id, action, actor_membership_id, target_membership_id)
           VALUES ($1, 'member_left', $2, $2)`,
          [m.project_id, m.membership_id],
        );
      }
    }
    // Credential・参加関係・セッション・Challengeは外部キーで連鎖削除される
    await tx.query('DELETE FROM auth_users WHERE id = $1', [userId]);
  });
}
