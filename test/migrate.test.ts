import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';

const adminUrl = process.env.TEST_PG_ADMIN_URL!;
const created: string[] = [];

async function admin(sql: string) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(sql);
  await c.end();
}

async function freshDb(): Promise<string> {
  const name = `myid_migrate_${randomBytes(6).toString('hex')}`;
  await admin(`CREATE DATABASE ${name}`);
  created.push(name);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

after(async () => {
  for (const name of created) await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
});

const allMigrations = async () =>
  (await readdir(path.join(import.meta.dirname, '..', 'migrations'))).filter((f) => f.endsWith('.sql')).sort();

test('空のDBにマイグレーションを適用でき、再実行しても変化しない', async () => {
  const url = await freshDb();
  assert.deepEqual(await migrate(url), await allMigrations());
  assert.deepEqual(await migrate(url), []);
});

test('適用済みマイグレーションの内容が変わっていれば停止する', async () => {
  const url = await freshDb();
  await migrate(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '001_initial.sql'");
  await c.end();
  await assert.rejects(migrate(url), /applied migration was modified/);
});

test('002: 既存の製品コード・契約番号は変換されず、適用後は小文字・日本語を保存できる', async () => {
  const url = await freshDb();
  assert.deepEqual(await migrate(url, { until: '001_initial.sql' }), ['001_initial.sql']);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  const user = await c.query("INSERT INTO auth_users (webauthn_user_handle) VALUES ($1) RETURNING id", [randomBytes(32)]);
  const project = await c.query("INSERT INTO projects (name) VALUES ('移行テスト') RETURNING id");
  const projectId = project.rows[0].id;
  const m = await c.query(
    "INSERT INTO project_memberships (project_id, user_id, role, status) VALUES ($1, $2, 'customer', 'active') RETURNING id",
    [projectId, user.rows[0].id],
  );
  await c.query("INSERT INTO project_permissions (membership_id, permission) VALUES ($1, 'members.manage')", [m.rows[0].id]);
  await c.query("INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, 'RL-LOCK-01', 1)", [projectId]);
  await c.query(
    "INSERT INTO project_contracts (project_id, contract_reference, amount_jpy, billing_status) VALUES ($1, 'C-0001', 1, 'paid')",
    [projectId],
  );
  await c.query('COMMIT');
  // 旧制約では小文字を保存できない
  await assert.rejects(
    c.query("INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, 'rl-lock-01', 1)", [projectId]),
    (err: any) => err.code === '23514',
  );

  assert.deepEqual(await migrate(url), ['002_relax_reference_codes.sql']);
  const products = await c.query('SELECT product_code FROM project_products ORDER BY created_at');
  assert.deepEqual(products.rows.map((r) => r.product_code), ['RL-LOCK-01']);
  const contract = await c.query('SELECT contract_reference FROM project_contracts');
  assert.equal(contract.rows[0].contract_reference, 'C-0001');

  await c.query("INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, 'rl-lock-01 本体', 1)", [projectId]);
  // DB制約でも前後の空白・制御文字・長さを拒否する
  for (const bad of [' lead', 'trail ', 'a\nb', 'x'.repeat(65), '']) {
    await assert.rejects(
      c.query('INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, $2, 1)', [projectId, bad]),
      (err: any) => err.code === '23514',
      JSON.stringify(bad),
    );
  }
  await c.end();
});
