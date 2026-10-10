import { createHash, randomBytes } from 'node:crypto';
import { type Request, Router } from 'express';
import type { Config } from '../config.ts';
import { type Db, withTransaction } from '../db.ts';
import { badRequest, conflict, HttpError, isUuid, notFound } from '../http.ts';
import {
  type Access,
  BILLING_STATUSES,
  grantPermissions,
  oneOf,
  type Permission,
  PERMISSIONS,
  parseName,
  parsePermissions,
  PROJECT_STATUSES,
  ROLES,
  recordAudit,
  recordEvent,
  WORK_TYPES,
  withProject,
} from '../projects.ts';
import { type AuthedRequest, requireAuth } from '../session.ts';

const uid = (req: Request) => (req as AuthedRequest).userId;
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseCode(value: unknown): string {
  if (typeof value !== 'string' || !CODE_RE.test(value)) throw badRequest();
  return value;
}

function parseIntInRange(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw badRequest();
  return value;
}

function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw badRequest();
  }
  return value;
}

function parseFutureTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw badRequest();
  const d = new Date(value);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) throw badRequest();
  return d;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function accessView(access: Access) {
  return {
    membershipId: access.membershipId,
    role: access.role,
    permissions: PERMISSIONS.filter((p) => access.permissions.has(p)),
  };
}

export function projectsRouter(config: Config, db: Db): Router {
  const r = Router();
  r.use(requireAuth(config, db));

  // ---- 案件一覧・作成 ----

  // 自分が参加している案件だけを返す
  // 検索は project.view を持つ案件の名前だけを対象にし、件数も同じ範囲で数える
  r.get('/projects', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const { rows } = await db.query(
      `WITH mine AS (
         SELECT m.project_id, m.id AS membership_id, m.role, m.status,
                coalesce(array_agg(p.permission::text ORDER BY p.permission)
                  FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
         FROM project_memberships m
         LEFT JOIN project_permissions p ON p.membership_id = m.id
         WHERE m.user_id = $1 AND (m.valid_until IS NULL OR m.valid_until > now())
         GROUP BY m.id
       )
       SELECT pr.id, mine.membership_id AS "membershipId", mine.role, mine.status AS "membershipStatus",
              mine.permissions,
              CASE WHEN viewable THEN pr.name END AS name,
              CASE WHEN viewable THEN pr.status END AS status
       FROM mine
       JOIN projects pr ON pr.id = mine.project_id
       CROSS JOIN LATERAL (
         SELECT mine.status = 'active' AND 'project.view' = ANY (mine.permissions) AS viewable
       ) v
       WHERE $2 = '' OR (viewable AND strpos(lower(pr.name), lower($2)) > 0)
       ORDER BY pr.created_at DESC`,
      [uid(req), q],
    );
    res.json({ projects: rows, total: rows.length });
  });

  r.post('/projects', async (req, res) => {
    const name = parseName(body(req).name);
    const id = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('INSERT INTO projects (name) VALUES ($1) RETURNING id', [name]);
      const projectId = rows[0]!.id;
      const m = await tx.query<{ id: string }>(
        `INSERT INTO project_memberships (project_id, user_id, role, status)
         VALUES ($1, $2, 'customer', 'active') RETURNING id`,
        [projectId, uid(req)],
      );
      const membershipId = m.rows[0]!.id;
      // PoCでは作成者を初期管理者とする
      await grantPermissions(tx, membershipId, [...PERMISSIONS]);
      await recordAudit(tx, projectId, 'member_added', {
        actorMembershipId: membershipId,
        targetMembershipId: membershipId,
        role: 'customer',
        permissions: [...PERMISSIONS],
      });
      await tx.query(
        `INSERT INTO project_events (project_id, event_type, actor_membership_id) VALUES ($1, 'project_created', $2)`,
        [projectId, membershipId],
      );
      return projectId;
    });
    res.status(201).json({ id });
  });

  // ---- 案件の基本情報 ----

  r.get('/projects/:projectId', async (req, res) => {
    const result = await withProject(db, req.params.projectId, uid(req), {}, async (tx, access) => {
      let project = null;
      if (access.permissions.has('project.view')) {
        const { rows } = await tx.query(
          'SELECT id, name, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM projects WHERE id = $1',
          [access.projectId],
        );
        project = rows[0];
      }
      return { id: access.projectId, access: accessView(access), project };
    });
    res.json(result);
  });

  r.patch('/projects/:projectId', async (req, res) => {
    const b = body(req);
    const name = b.name === undefined ? undefined : parseName(b.name);
    const status = b.status === undefined ? undefined : oneOf(PROJECT_STATUSES, b.status);
    if (name === undefined && status === undefined) throw badRequest();
    await withProject(db, req.params.projectId, uid(req), { permission: 'project.edit', lock: 'update' }, async (tx, access) => {
      const { rows } = await tx.query<{ name: string; status: string }>('SELECT name, status FROM projects WHERE id = $1', [
        access.projectId,
      ]);
      const current = rows[0]!;
      await tx.query(
        'UPDATE projects SET name = coalesce($2, name), status = coalesce($3::project_status, status), updated_at = now() WHERE id = $1',
        [access.projectId, name ?? null, status ?? null],
      );
      if (name !== undefined && name !== current.name) await recordEvent(tx, access, 'project_renamed');
      if (status !== undefined && status !== current.status) {
        await recordEvent(tx, access, 'status_changed', current.status, status);
      }
    });
    res.status(204).end();
  });

  // ---- 案件共通情報（製品・作業予定） ----

  r.get('/projects/:projectId/products', async (req, res) => {
    const rows = await withProject(db, req.params.projectId, uid(req), { permission: 'details.view' }, async (tx, a) => {
      const result = await tx.query(
        `SELECT id, product_code AS "productCode", quantity, created_at AS "createdAt"
         FROM project_products WHERE project_id = $1 ORDER BY created_at`,
        [a.projectId],
      );
      return result.rows;
    });
    res.json({ products: rows });
  });

  r.post('/projects/:projectId/products', async (req, res) => {
    const productCode = parseCode(body(req).productCode);
    const quantity = parseIntInRange(body(req).quantity, 1, 10000);
    await withProject(db, req.params.projectId, uid(req), { permission: 'details.edit' }, async (tx, a) => {
      await tx.query('INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, $2, $3)', [
        a.projectId,
        productCode,
        quantity,
      ]);
      await recordEvent(tx, a, 'product_added');
    });
    res.status(201).end();
  });

  r.get('/projects/:projectId/schedules', async (req, res) => {
    const rows = await withProject(db, req.params.projectId, uid(req), { permission: 'details.view' }, async (tx, a) => {
      const result = await tx.query(
        `SELECT id, work_type AS "workType", to_char(scheduled_on, 'YYYY-MM-DD') AS "scheduledOn"
         FROM project_work_schedules WHERE project_id = $1 ORDER BY scheduled_on`,
        [a.projectId],
      );
      return result.rows;
    });
    res.json({ schedules: rows });
  });

  r.post('/projects/:projectId/schedules', async (req, res) => {
    const workType = oneOf(WORK_TYPES, body(req).workType);
    const scheduledOn = parseDate(body(req).scheduledOn);
    await withProject(db, req.params.projectId, uid(req), { permission: 'details.edit' }, async (tx, a) => {
      await tx.query('INSERT INTO project_work_schedules (project_id, work_type, scheduled_on) VALUES ($1, $2, $3)', [
        a.projectId,
        workType,
        scheduledOn,
      ]);
      await recordEvent(tx, a, 'schedule_added');
    });
    res.status(201).end();
  });

  // ---- 権限が限定される情報（契約ダミー） ----

  r.get('/projects/:projectId/contract', async (req, res) => {
    const contract = await withProject(db, req.params.projectId, uid(req), { permission: 'contract.view' }, async (tx, a) => {
      const { rows } = await tx.query(
        `SELECT contract_reference AS "contractReference", amount_jpy::text AS "amountJpy",
                billing_status AS "billingStatus", updated_at AS "updatedAt"
         FROM project_contracts WHERE project_id = $1`,
        [a.projectId],
      );
      return rows[0] ?? null;
    });
    res.json({ contract });
  });

  r.put('/projects/:projectId/contract', async (req, res) => {
    const contractReference = parseCode(body(req).contractReference);
    const amountJpy = parseIntInRange(body(req).amountJpy, 0, 1_000_000_000_000);
    const billingStatus = oneOf(BILLING_STATUSES, body(req).billingStatus);
    await withProject(db, req.params.projectId, uid(req), { permission: 'contract.edit' }, async (tx, a) => {
      await tx.query(
        `INSERT INTO project_contracts (project_id, contract_reference, amount_jpy, billing_status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id) DO UPDATE
           SET contract_reference = EXCLUDED.contract_reference, amount_jpy = EXCLUDED.amount_jpy,
               billing_status = EXCLUDED.billing_status, updated_at = now()`,
        [a.projectId, contractReference, amountJpy, billingStatus],
      );
      await recordEvent(tx, a, 'contract_updated');
    });
    res.status(204).end();
  });

  r.get('/projects/:projectId/events', async (req, res) => {
    const rows = await withProject(db, req.params.projectId, uid(req), { permission: 'events.view' }, async (tx, a) => {
      const result = await tx.query(
        `SELECT id, event_type AS "eventType", actor_membership_id AS "actorMembershipId",
                status_from AS "statusFrom", status_to AS "statusTo", occurred_at AS "occurredAt"
         FROM project_events WHERE project_id = $1 ORDER BY seq`,
        [a.projectId],
      );
      return result.rows;
    });
    res.json({ events: rows });
  });

  // ---- 参加者管理（members.manage） ----

  r.get('/projects/:projectId/members', async (req, res) => {
    const rows = await withProject(db, req.params.projectId, uid(req), { permission: 'members.manage' }, async (tx, a) => {
      // ユーザーIDは返さない（案件をまたいだ同一人物の照合を防ぐ）
      const result = await tx.query(
        `SELECT m.id, m.role, m.status, m.valid_until AS "validUntil", m.created_at AS "createdAt",
                m.id = $2 AS "isSelf",
                coalesce(array_agg(p.permission::text ORDER BY p.permission)
                  FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
         FROM project_memberships m
         LEFT JOIN project_permissions p ON p.membership_id = m.id
         WHERE m.project_id = $1
         GROUP BY m.id ORDER BY m.created_at`,
        [a.projectId, a.membershipId],
      );
      return result.rows;
    });
    res.json({ members: rows });
  });

  r.patch('/projects/:projectId/members/:membershipId', async (req, res) => {
    const b = body(req);
    const role = b.role === undefined ? undefined : oneOf(ROLES, b.role);
    const permissions = b.permissions === undefined ? undefined : parsePermissions(b.permissions);
    const validUntil = b.validUntil === undefined ? undefined : parseFutureTimestamp(b.validUntil);
    if (role === undefined && permissions === undefined && validUntil === undefined) throw badRequest();
    const targetId = req.params.membershipId;
    await withProject(db, req.params.projectId, uid(req), { permission: 'members.manage', lock: 'update' }, async (tx, a) => {
      if (!isUuid(targetId)) throw notFound();
      const target = await tx.query<{ role: string }>(
        'SELECT role FROM project_memberships WHERE id = $1 AND project_id = $2 FOR UPDATE',
        [targetId, a.projectId],
      );
      if (!target.rowCount) throw notFound();
      await tx.query(
        `UPDATE project_memberships
         SET role = coalesce($2::project_role, role),
             valid_until = CASE WHEN $3 THEN $4::timestamptz ELSE valid_until END,
             updated_at = now()
         WHERE id = $1`,
        [targetId, role ?? null, validUntil !== undefined, validUntil ?? null],
      );
      if (permissions !== undefined) {
        // 差分だけを更新する（維持された権限の付与日時と、それに紐付く招待を保つ）
        await tx.query(
          'DELETE FROM project_permissions WHERE membership_id = $1 AND NOT (permission = ANY ($2::project_permission[]))',
          [targetId, permissions],
        );
        await tx.query(
          `INSERT INTO project_permissions (membership_id, permission)
           SELECT $1, unnest($2::project_permission[]) ON CONFLICT DO NOTHING`,
          [targetId, permissions],
        );
      }
      await recordAudit(tx, a.projectId, 'member_updated', {
        actorMembershipId: a.membershipId,
        targetMembershipId: targetId,
        role: role ?? null,
        permissions: permissions ?? null,
      });
    });
    res.status(204).end();
  });

  r.post('/projects/:projectId/members/:membershipId/approve', async (req, res) => {
    const targetId = req.params.membershipId;
    await withProject(db, req.params.projectId, uid(req), { permission: 'members.manage', lock: 'update' }, async (tx, a) => {
      if (!isUuid(targetId)) throw notFound();
      const { rowCount } = await tx.query(
        `UPDATE project_memberships SET status = 'active', updated_at = now()
         WHERE id = $1 AND project_id = $2 AND status = 'pending_approval'`,
        [targetId, a.projectId],
      );
      if (!rowCount) throw notFound();
      await recordAudit(tx, a.projectId, 'member_approved', {
        actorMembershipId: a.membershipId,
        targetMembershipId: targetId,
      });
    });
    res.status(204).end();
  });

  // 管理者による失効、または本人による退出
  r.delete('/projects/:projectId/members/:membershipId', async (req, res) => {
    const targetId = req.params.membershipId;
    await withProject(db, req.params.projectId, uid(req), { lock: 'update' }, async (tx, a) => {
      if (!isUuid(targetId)) throw notFound();
      const isSelf = targetId === a.membershipId;
      if (!isSelf && !a.permissions.has('members.manage')) throw new HttpError(403, 'forbidden');
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
    const rows = await withProject(db, req.params.projectId, uid(req), { permission: 'members.manage' }, async (tx, a) => {
      const result = await tx.query(
        `SELECT id, action, actor_membership_id AS "actorMembershipId", target_membership_id AS "targetMembershipId",
                invitation_id AS "invitationId", role, permissions::text[] AS permissions, occurred_at AS "occurredAt"
         FROM project_audit_log WHERE project_id = $1 ORDER BY seq`,
        [a.projectId],
      );
      return result.rows;
    });
    res.json({ audit: rows });
  });

  // ---- 招待 ----

  r.get('/projects/:projectId/invitations', async (req, res) => {
    const rows = await withProject(db, req.params.projectId, uid(req), { permission: 'members.manage' }, async (tx, a) => {
      const result = await tx.query(
        `SELECT i.id, i.role, i.requires_approval AS "requiresApproval",
                CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status::text END AS status,
                i.created_at AS "createdAt", i.expires_at AS "expiresAt",
                coalesce(array_agg(p.permission::text ORDER BY p.permission)
                  FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
         FROM project_invitations i
         LEFT JOIN project_invitation_permissions p ON p.invitation_id = i.id
         WHERE i.project_id = $1
         GROUP BY i.id ORDER BY i.created_at DESC`,
        [a.projectId],
      );
      return result.rows;
    });
    res.json({ invitations: rows });
  });

  r.post('/projects/:projectId/invitations', async (req, res) => {
    const b = body(req);
    const role = oneOf(ROLES, b.role);
    const permissions = parsePermissions(b.permissions);
    const ttlHours = b.ttlHours === undefined ? 72 : parseIntInRange(b.ttlHours, 1, 168);
    const requiresApproval = b.requiresApproval === undefined ? false : b.requiresApproval;
    if (typeof requiresApproval !== 'boolean') throw badRequest();
    // 256bitの乱数
    // DBにはハッシュのみ保存し、トークンはこのレスポンスでだけ返す
    const token = randomBytes(32).toString('base64url');
    const result = await withProject(db, req.params.projectId, uid(req), { permission: 'members.manage' }, async (tx, a) => {
      const { rows } = await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO project_invitations
           (project_id, token_hash, role, requires_approval, created_by_membership_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
         RETURNING id, expires_at`,
        [a.projectId, hashToken(token), role, requiresApproval, a.membershipId, ttlHours],
      );
      const inv = rows[0]!;
      if (permissions.length) {
        await tx.query(
          `INSERT INTO project_invitation_permissions (invitation_id, permission)
           SELECT $1, unnest($2::project_permission[])`,
          [inv.id, permissions],
        );
      }
      await recordAudit(tx, a.projectId, 'invitation_created', {
        actorMembershipId: a.membershipId,
        invitationId: inv.id,
        role,
        permissions,
      });
      return inv;
    });
    res.status(201).json({ id: result.id, token, expiresAt: result.expires_at });
  });

  r.delete('/projects/:projectId/invitations/:invitationId', async (req, res) => {
    const invitationId = req.params.invitationId;
    await withProject(db, req.params.projectId, uid(req), { permission: 'members.manage' }, async (tx, a) => {
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
      const { rows } = await tx.query<{ id: string; role: string; requires_approval: boolean }>(
        `UPDATE project_invitations SET status = 'accepted', accepted_at = now()
         WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
         RETURNING id, role, requires_approval`,
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
      const perms = await tx.query<{ permission: Permission }>(
        'SELECT permission FROM project_invitation_permissions WHERE invitation_id = $1',
        [inv.id],
      );
      const permissions = perms.rows.map((p) => p.permission);
      const status = inv.requires_approval ? 'pending_approval' : 'active';
      const m = await tx.query<{ id: string }>(
        `INSERT INTO project_memberships (project_id, user_id, role, status) VALUES ($1, $2, $3, $4) RETURNING id`,
        [projectId, userId, inv.role, status],
      );
      const membershipId = m.rows[0]!.id;
      await grantPermissions(tx, membershipId, permissions);
      await recordAudit(tx, projectId, 'member_added', {
        actorMembershipId: membershipId,
        targetMembershipId: membershipId,
        invitationId: inv.id,
        role: inv.role,
        permissions,
      });
      return { projectId, membershipId, membershipStatus: status };
    });
    res.status(201).json(result);
  });

  return r;
}

const invalidInvitation = () => new HttpError(404, 'invitation_invalid');
