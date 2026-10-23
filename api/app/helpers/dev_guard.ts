/**
 * Dev-only commands must never touch a shared or production database: refuse unless
 * NODE_ENV=development and the DB host is this machine.
 */
export function assertLocalDevDatabase(env: { get: (key: string) => unknown }) {
  const host = String(env.get('DB_HOST'))
  if (env.get('NODE_ENV') !== 'development' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Refusing: dev-only command (NODE_ENV=${env.get('NODE_ENV')}, DB_HOST=${host})`)
  }
}
