import { createHash, randomBytes } from 'node:crypto';
import { type Request, Router } from 'express';
import type { Config } from '../config.ts';
import { type Db, withTransaction } from '../db.ts';
import { conflict, forbidden, HttpError, isUuid, notFound } from '../http.ts';
import { allowedActions, can, parseName, recordAudit, withProject } from '../projects.ts';
import { type AuthedRequest, requireAuth } from '../session.ts';

const uid = (req: Request) => (req as AuthedRequest).userId;
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

// 招待の有効期限（顧客には選ばせない）
const INVITATION_TTL_HOURS = 72;

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

const invalidInvitation = () => new HttpError(404, 'invitation_invalid');

export function projectsRouter(config: Config, db: Db): Router {
  const r = Router();
  r.use(requireAuth(config, db));

  // ---- 案件一覧・作成 ----

  // 自分が参加している案件だけを返す
  r.get('/projects', async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.id, p.name, m.role, p.created_at AS "createdAt", p.updated_at AS "updatedAt"
       FROM project_memberships m
       JOIN projects p ON p.id = m.project_id
       WHERE m.user_id = $1
       ORDER BY p.created_at DESC`,
      [uid(req)],
    );
    res.json({ projects: rows, total: rows.length });
  });

  r.post('/projects', async (req, res) => {
    const name = parseName(body(req).name);
    const id = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('INSERT INTO projects (name) VALUES ($1) RETURNING id', [name]);
      const projectId = rows[0]!.id;
      // 案件作成者を初期管理者とする（PoC仕様）
      const m = await tx.query<{ id: string }>(
        `INSERT INTO project_memberships (project_id, user_id, role) VALUES ($1, $2, 'manager') RETURNING id`,
        [projectId, uid(req)],
      );
      const membershipId = m.rows[0]!.id;
      await recordAudit(tx, projectId, 'project_created', { actorMembershipId: membershipId });
      await recordAudit(tx, projectId, 'member_added', {
        actorMembershipId: membershipId,
        targetMembershipId: membershipId,
        memberRole: 'manager',
      });
      return projectId;
    });
    res.status(201).json({ id });
  });

  // ---- 案件 ----

  r.get('/projects/:projectId', async (req, res) => {
    const result = await withProject(db, req.params.projectId, uid(req), { action: 'project.view' }, async (tx, a) => {
      const { rows } = await tx.query(
        'SELECT id, name, created_at AS "createdAt", updated_at AS "updatedAt" FROM projects WHERE id = $1',
        [a.projectId],
      );
      // 画面の表示切り替え用（判定はAPIごとにサーバーで行う）
      return { ...rows[0], access: { membershipId: a.membershipId, role: a.role, actions: allowedActions(a.role) } };
    });
    res.json(result);
  });

  r.patch('/projects/:projectId', async (req, res) => {
    const name = parseName(body(req).name);
    await withProject(db, req.params.projectId, uid(req), { action: 'project.rename', lock: 'update' }, async (tx, a) => {
      await tx.query('UPDATE projects SET name = $2, updated_at = now() WHERE id = $1', [a.projectId, name]);
      await recordAudit(tx, a.projectId, 'project_renamed', { actorMembershipId: a.membershipId });
    });
    res.status(204).end();
  });

  // ---- 参加者 ----

  // ユーザーIDは返さない（案件をまたいだ同一人物の照合を防ぐ）
  r.get('/projects/:projectId/members', async (req, res) => {
    const rows = await withProject(db, req.params.projectId, uid(req), { action: 'members.view' }, async (tx, a) => {
      const result = await tx.query(
        `SELECT id, role, created_at AS "joinedAt", id = $2 AS "isSelf"
         FROM project_memberships WHERE project_id = $1 ORDER BY created_at`,
        [a.projectId, a.membershipId],
      );
      return result.rows;
    });
    res.json({ members: rows });
  });

  // 管理者による参加解除、または本人による退出
  // 最後の管理者を外す操作はDBの制約トリガーが拒否する（409 last_manager）
  r.delete('/projects/:projectId/members/:membershipId', async (req, res) => {
    const targetId = req.params.membershipId;
    await withProject(db, req.params.projectId, uid(req), { action: 'project.view', lock: 'update' }, async (tx, a) => {
      if (!isUuid(targetId)) throw notFound();
      const isSelf = targetId === a.membershipId;
      if (!isSelf && !can(a.role, 'members.remove')) throw forbidden();
      const { rowCount } = await tx.query('DELETE FROM project_memberships WHERE id = $1 AND project_id = $2', [
        targetId,
        a.projectId,
      ]);
      if (!rowCount) throw notFound();
      await recordAudit(tx, a.projectId, isSelf ? 'member_left' : 'member_revoked', {
        actorMembershipId: a.membershipId,
        targetMembershipId: targetId,
      });
    });
    res.status(204).end();
  });

  r.get('/projects/:projectId/audit', async (req, res) => {
    const rows = await withProject(db, req.params.projectId, uid(req), { action: 'audit.view' }, async (tx, a) => {
      const result = await tx.query(
        `SELECT id, action, actor_membership_id AS "actorMembershipId", target_membership_id AS "targetMembershipId",
                invitation_id AS "invitationId", member_role AS "memberRole", occurred_at AS "occurredAt"
         FROM project_audit_log WHERE project_id = $1 ORDER BY seq`,
        [a.projectId],
      );
      return result.rows;
    });
    res.json({ audit: rows });
  });

  // ---- 招待 ----

  r.get('/projects/:projectId/invitations', async (req, res) => {
    const rows = await withProject(db, req.params.projectId, uid(req), { action: 'invitations.manage' }, async (tx, a) => {
      const result = await tx.query(
        `SELECT id,
                CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status::text END AS status,
                created_at AS "createdAt", expires_at AS "expiresAt"
         FROM project_invitations WHERE project_id = $1 ORDER BY created_at DESC`,
        [a.projectId],
      );
      return result.rows;
    });
    res.json({ invitations: rows });
  });

  // 役割・権限・承認制・有効期限は受け付けない（本文の値は無視する）
  r.post('/projects/:projectId/invitations', async (req, res) => {
    // 256bitの乱数
    // DBにはハッシュのみ保存し、トークンはこのレスポンスでだけ返す
    const token = randomBytes(32).toString('base64url');
    const result = await withProject(db, req.params.projectId, uid(req), { action: 'invitations.manage' }, async (tx, a) => {
      const { rows } = await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO project_invitations (project_id, token_hash, created_by_membership_id, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4))
         RETURNING id, expires_at`,
        [a.projectId, hashToken(token), a.membershipId, INVITATION_TTL_HOURS],
      );
      const inv = rows[0]!;
      await recordAudit(tx, a.projectId, 'invitation_created', { actorMembershipId: a.membershipId, invitationId: inv.id });
      return inv;
    });
    res.status(201).json({ id: result.id, token, expiresAt: result.expires_at });
  });

  r.delete('/projects/:projectId/invitations/:invitationId', async (req, res) => {
    const invitationId = req.params.invitationId;
    await withProject(db, req.params.projectId, uid(req), { action: 'invitations.manage' }, async (tx, a) => {
      if (!isUuid(invitationId)) throw notFound();
      const { rowCount } = await tx.query(
        `UPDATE project_invitations SET status = 'revoked', revoked_at = now()
         WHERE id = $1 AND project_id = $2 AND status = 'pending'`,
        [invitationId, a.projectId],
      );
      if (!rowCount) throw notFound();
      await recordAudit(tx, a.projectId, 'invitation_revoked', { actorMembershipId: a.membershipId, invitationId });
    });
    res.status(204).end();
  });

  // 招待の受諾（Passkeyでログイン済みであること）
  // トークン単体では案件情報を返さない
  r.post('/invitations/accept', async (req, res) => {
    const token = body(req).token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidInvitation();
    const userId = uid(req);
    const result = await withTransaction(db, async (tx) => {
      const found = await tx.query<{ project_id: string }>(
        'SELECT project_id FROM project_invitations WHERE token_hash = $1',
        [hashToken(token)],
      );
      if (!found.rowCount) throw invalidInvitation();
      const projectId = found.rows[0]!.project_id;
      await tx.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      // 使用済み化と参加登録を同一トランザクションで行う
      // 同時に受諾しても、この条件付き更新に成功するのは1件だけ
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE project_invitations SET status = 'accepted', accepted_at = now()
         WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
         RETURNING id`,
        [hashToken(token)],
      );
      const inv = rows[0];
      if (!inv) throw invalidInvitation();
      const existing = await tx.query('SELECT 1 FROM project_memberships WHERE project_id = $1 AND user_id = $2', [
        projectId,
        userId,
      ]);
      // ロールバックされるため招待は未使用のまま残る
      if (existing.rowCount) throw conflict('already_member');
      // 招待で参加した人は常に一般参加者
      const m = await tx.query<{ id: string }>(
        `INSERT INTO project_memberships (project_id, user_id, role) VALUES ($1, $2, 'member') RETURNING id`,
        [projectId, userId],
      );
      const membershipId = m.rows[0]!.id;
      await recordAudit(tx, projectId, 'member_added', {
        actorMembershipId: membershipId,
        targetMembershipId: membershipId,
        invitationId: inv.id,
        memberRole: 'member',
      });
      return { projectId, membershipId };
    });
    res.status(201).json(result);
  });

  return r;
}
