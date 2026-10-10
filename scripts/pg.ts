import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

// Docker を使わずにローカルで PostgreSQL を起動する（開発・テスト用）
// 127.0.0.1 のみで待ち受ける

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export type LocalPg = { url: (db: string) => string; pg: EmbeddedPostgres; stop: () => Promise<void> };

export async function startLocalPg(opts: { dir: string; persistent: boolean; port?: number }): Promise<LocalPg> {
  await mkdir(path.dirname(opts.dir), { recursive: true });
  const secretFile = `${opts.dir}.secret.json`;
  let secret: { password: string; port: number; initialised?: boolean };
  try {
    secret = JSON.parse(await readFile(secretFile, 'utf8'));
  } catch {
    secret = { password: randomBytes(24).toString('base64url'), port: opts.port ?? (await freePort()) };
  }
  const pg = new EmbeddedPostgres({
    databaseDir: opts.dir,
    user: 'postgres',
    password: secret.password,
    port: secret.port,
    persistent: opts.persistent,
    authMethod: 'scram-sha-256',
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'timezone=UTC'],
    onLog: () => {},
  });
  if (!secret.initialised) {
    await pg.initialise();
    if (opts.persistent) await writeFile(secretFile, JSON.stringify({ ...secret, initialised: true }), { mode: 0o600 });
  }
  await pg.start();
  return {
    pg,
    url: (db) => `postgres://postgres:${encodeURIComponent(secret.password)}@127.0.0.1:${secret.port}/${db}`,
    stop: () => pg.stop(),
  };
}
