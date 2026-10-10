import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config.ts';
import { createPool, type Db } from '../src/db.ts';
import { VirtualAuthenticator, type VirtualCredential } from './authenticator.ts';

export const ORIGIN = 'https://myid.test';
export const RP_ID = 'myid.test';

export type TestEnv = {
  db: Db;
  config: Config;
  baseUrl: string;
  client: () => Client;
  close: () => Promise<void>;
};

// テストファイルごとにテンプレートDBを複製し、アプリを一時ポートで起動する
export async function setupEnv(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  const template = process.env.TEST_PG_TEMPLATE;
  if (!adminUrl || !template) throw new Error('run tests via `npm test`');
  const dbName = `myid_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${template}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;

  const config = {
    ...loadConfig({
      DATABASE_URL: url.toString(),
      ORIGIN,
      RP_ID,
      SESSION_SECRET: randomBytes(32).toString('base64url'),
      COOKIE_SECURE: 'false',
    }),
    ...overrides,
  };
  const db = createPool(config.databaseUrl);
  const server = http.createServer(createApp(config, db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db,
    config,
    baseUrl,
    client: () => new Client(baseUrl),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await a.end();
    },
  };
}

export type Res = { status: number; body: any };

// Cookie と CSRF トークンを保持する簡易HTTPクライアント
export class Client {
  baseUrl: string;
  cookie: string | null = null;
  csrf: string | null = null;
  origin = ORIGIN;
  authenticator = new VirtualAuthenticator(ORIGIN);

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { origin: this.origin, ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && !('x-csrf-token' in h)) h['x-csrf-token'] = this.csrf;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie();
    for (const c of setCookie) {
      const [pair] = c.split(';');
      if (pair!.endsWith('=')) this.cookie = null;
      else this.cookie = pair!;
    }
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed.csrfToken === 'string') this.csrf = parsed.csrfToken;
    return { status: res.status, body: parsed };
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, body: unknown = {}) {
    return this.request('POST', path, body);
  }
  patch(path: string, body: unknown) {
    return this.request('PATCH', path, body);
  }
  put(path: string, body: unknown) {
    return this.request('PUT', path, body);
  }
  delete(path: string, body: unknown = {}) {
    return this.request('DELETE', path, body);
  }

  async init(): Promise<void> {
    await this.get('/api/session');
  }

  async register(): Promise<VirtualCredential> {
    await this.init();
    const opts = await this.post('/api/auth/register/options');
    if (opts.status !== 200) throw new Error(`register options ${opts.status}`);
    const response = this.authenticator.create(opts.body);
    const res = await this.post('/api/auth/register/verify', { response });
    if (res.status !== 201) throw new Error(`register verify ${res.status} ${JSON.stringify(res.body)}`);
    return this.authenticator.credentials.at(-1)!;
  }

  async login(credential?: VirtualCredential): Promise<Res> {
    await this.init();
    const opts = await this.post('/api/auth/login/options');
    return this.post('/api/auth/login/verify', { response: this.authenticator.get(opts.body, credential) });
  }

  async reauth(credential?: VirtualCredential): Promise<Res> {
    const opts = await this.post('/api/auth/reauth/options');
    return this.post('/api/auth/reauth/verify', { response: this.authenticator.get(opts.body, credential) });
  }

  // 別の端末（認証器）にPasskeyを追加する
  async addPasskey(device = new VirtualAuthenticator(ORIGIN)): Promise<VirtualCredential> {
    const opts = await this.post('/api/account/passkeys/options');
    if (opts.status !== 200) throw new Error(`add options ${opts.status}`);
    const res = await this.post('/api/account/passkeys/verify', { response: device.create(opts.body) });
    if (res.status !== 201) throw new Error(`add verify ${res.status}`);
    const cred = device.credentials.at(-1)!;
    this.authenticator.credentials.push(cred);
    return cred;
  }

  async createProject(name = 'テスト案件'): Promise<string> {
    const res = await this.post('/api/projects', { name });
    if (res.status !== 201) throw new Error(`create project ${res.status}`);
    return res.body.id;
  }
}

// 招待を発行して別ユーザーに受諾させる
export async function inviteAndJoin(
  manager: Client,
  invitee: Client,
  projectId: string,
): Promise<{ membershipId: string; invitationId: string }> {
  const inv = await manager.post(`/api/projects/${projectId}/invitations`);
  if (inv.status !== 201) throw new Error(`invite ${inv.status}`);
  const acc = await invitee.post('/api/invitations/accept', { token: inv.body.token });
  if (acc.status !== 201) throw new Error(`accept ${acc.status}`);
  return { membershipId: acc.body.membershipId, invitationId: inv.body.id };
}

// 移行前のデータなど、APIでは作れない管理者を用意する
export async function promoteToManager(env: TestEnv, membershipId: string): Promise<void> {
  await env.db.query("UPDATE project_memberships SET role = 'manager' WHERE id = $1", [membershipId]);
}
