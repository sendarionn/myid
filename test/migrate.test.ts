import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';

const adminUrl = process.env.TEST_PG_ADMIN_URL!;
const dbName = `myid_migrate_${randomBytes(6).toString('hex')}`;
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;

async function admin(sql: string) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(sql);
  await c.end();
}

after(() => admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));

test('空のDBにマイグレーションを適用でき、再実行しても変化しない', async () => {
  await admin(`CREATE DATABASE ${dbName}`);
  assert.deepEqual(await migrate(url.toString()), ['001_initial.sql']);
  assert.deepEqual(await migrate(url.toString()), []);
});

test('適用済みマイグレーションの内容が変わっていれば停止する', async () => {
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  await c.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '001_initial.sql'");
  await c.end();
  await assert.rejects(migrate(url.toString()), /applied migration was modified/);
});
