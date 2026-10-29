import db from '@adonisjs/lucid/services/db'
import { sha256 } from '#helpers/tokens'
import type { Actor } from '#services/actor'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

export type Outcome = 'success' | 'denied' | 'failure'

export interface AuditEntry {
  actor?: Actor | null
  /** For events without a signed-in actor (failed logins, setup links). */
  actorId?: number | null
  actorEmail?: string | null
  action: string
  targetType?: string | null
  targetId?: string | number | null
  outcome?: Outcome
  reason?: string | null
  metadata?: Record<string, unknown> | null
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

const GENESIS = '0'.repeat(64)

/** JSON with sorted keys: MySQL's JSON type reorders keys, the hash must not care. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Non-integer numbers rounded to 15 significant digits. MySQL's JSON type doesn't read a
 * 17-digit decimal back bit-for-bit (1.4936000000000003 returns as 1.4936000000000005),
 * which would make a genuine entry fail verification; 15 digits round-trip exactly.
 */
export function stableNumbers(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) && !Number.isInteger(value) ? Number(value.toPrecision(15)) : value
  if (Array.isArray(value)) return value.map(stableNumbers)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stableNumbers(v)]))
  return value
}

interface Row {
  id?: number
  created_at: Date
  actor_id: number | null
  actor_email: string | null
  action: string
  target_type: string | null
  target_id: string | null
  outcome: string
  reason: string | null
  metadata: unknown
  ip: string | null
  user_agent: string | null
  request_id: string | null
  prev_hash: string
  hash?: string
}

/**
 * The row's hash covers every column and the previous row's hash. `created_at` enters as
 * epoch seconds of the value MySQL hands back (whole seconds, read in the same process
 * time zone it was written in: run the API with a fixed TZ).
 */
function rowHash(row: Row) {
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
  return sha256(
    row.prev_hash +
      canonical([
        Math.floor(new Date(row.created_at).getTime() / 1000),
        row.actor_id,
        row.actor_email,
        row.action,
        row.target_type,
        row.target_id,
        row.outcome,
        row.reason,
        metadata ?? null,
        row.ip,
        row.user_agent,
        row.request_id,
      ])
  )
}

class AuditService {
  /**
   * Appends one entry. Pass the action's transaction so the entry commits (or rolls
   * back) with the change it describes; it is written last, holding the head row lock,
   * so appends never fork the chain.
   */
  async record(entry: AuditEntry, trx?: TransactionClientContract): Promise<number> {
    if (!trx) return db.transaction((own): Promise<number> => this.record(entry, own))

    const head = await trx.from('console_audit_head').where('id', 1).forUpdate().first()
    const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000)
    const actor = entry.actor
    const row: Row = {
      created_at: createdAt,
      actor_id: actor?.user.id ?? entry.actorId ?? null,
      actor_email: actor?.user.email ?? entry.actorEmail ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId === undefined || entry.targetId === null ? null : String(entry.targetId),
      outcome: entry.outcome ?? 'success',
      reason: entry.reason?.slice(0, 500) ?? null,
      metadata: entry.metadata ? stableNumbers(JSON.parse(canonical(entry.metadata))) : null,
      ip: actor?.ip ?? entry.ip ?? null,
      user_agent: (actor?.userAgent ?? entry.userAgent ?? null)?.slice(0, 255) ?? null,
      request_id: actor?.requestId ?? entry.requestId ?? null,
      prev_hash: head?.last_hash ?? GENESIS,
    }
    row.hash = rowHash(row)
    const [id] = await trx.table('console_audit_logs').insert({
      ...row,
      metadata: row.metadata === null ? null : JSON.stringify(row.metadata),
    })
    await trx.from('console_audit_head').where('id', 1).update({ last_id: id, last_hash: row.hash })
    return id as number
  }

  /** Recomputes the chain; returns the first row that doesn't match, if any. */
  async verify(limit = 100_000) {
    let prev = GENESIS
    let checked = 0
    let lastId = 0
    const batch = 1000
    while (checked < limit) {
      const rows: Row[] = await db
        .from('console_audit_logs')
        .where('id', '>', lastId)
        .orderBy('id', 'asc')
        .limit(batch)
      if (!rows.length) break
      for (const row of rows) {
        if (row.prev_hash !== prev || rowHash(row) !== row.hash) {
          return { ok: false, checked, brokenAt: row.id }
        }
        prev = row.hash!
        lastId = row.id!
        checked++
      }
    }
    const head = await db.from('console_audit_head').where('id', 1).first()
    if (checked < limit && head && head.last_hash !== prev) {
      // Rows after the last one we saw were deleted (the head still remembers them).
      return { ok: false, checked, brokenAt: lastId + 1, tailDeleted: true }
    }
    return { ok: true, checked }
  }
}

export default new AuditService()
