import db from '@adonisjs/lucid/services/db'

/**
 * Whether a table exists in the shared database (cached a minute). The console runs
 * against databases where some monolith tables don't exist (local dev, staging copies).
 */
const cache = new Map<string, { at: number; exists: boolean }>()

export async function tableExists(name: string) {
  const hit = cache.get(name)
  if (hit && Date.now() - hit.at < 60_000) return hit.exists
  const rows = await db
    .from('information_schema.tables')
    .whereRaw('table_schema = DATABASE()')
    .where('table_name', name)
    .count('* as total')
  const exists = Number(rows[0]?.total ?? 0) > 0
  cache.set(name, { at: Date.now(), exists })
  return exists
}

/** Columns that must never leave the server, whatever the table. */
const SECRET = /pass|token|otp|secret|salt|hash|pin_?code|remember|api_?key|private|fcm|device_?id|session_?key/i

/** A row without secret-looking columns, ready to show on a profile page. */
export function withoutSecrets(row: Record<string, unknown> | null | undefined) {
  if (!row) return null
  return Object.fromEntries(Object.entries(row).filter(([key]) => !SECRET.test(key)))
}
