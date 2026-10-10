export type Config = {
  host: string;
  port: number;
  databaseUrl: string;
  rpId: string;
  rpName: string;
  origin: string;
  sessionSecret: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  reauthWindowMs: number;
  challengeTtlMs: number;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = new URL(required(env, 'ORIGIN')).origin;
  const rpId = env.RP_ID || new URL(origin).hostname;
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const cookieSecure = (env.COOKIE_SECURE ?? (origin.startsWith('https:') ? 'true' : 'false')) === 'true';
  if (env.NODE_ENV === 'production' && (!origin.startsWith('https:') || !cookieSecure)) {
    throw new Error('production requires an https ORIGIN and secure cookies');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    rpId,
    rpName: env.RP_NAME ?? 'myid',
    origin,
    sessionSecret,
    cookieSecure,
    trustProxy: env.TRUST_PROXY === 'true',
    sessionIdleMs: 30 * 60 * 1000,
    sessionAbsoluteMs: 12 * 60 * 60 * 1000,
    reauthWindowMs: 5 * 60 * 1000,
    challengeTtlMs: 5 * 60 * 1000,
  };
}
