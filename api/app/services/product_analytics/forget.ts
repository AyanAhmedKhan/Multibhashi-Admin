import db from '@adonisjs/lucid/services/db'
import { isNotFound, type QueryTypes, type Refs, type Warehouse } from '#services/product_analytics/warehouse'

/**
 * Deleting one learner from product analytics (MUL-153, design/IMPLEMENTATION-CONTRACTS.md
 * §5.4): `analytics:forget-user <appspot_id|td_user_id>`.
 *
 * 1. Resolve the learner's ids: the appspot _id(s) the app sends as user_id, the
 *    teachers-dashboard users.id(s) the facts are keyed by (both through identities and, when
 *    it exists, MySQL learner_accounts), and the anonymous ids their devices used before
 *    signing in (m_identity_links and the events themselves).
 * 2. Delete, table by table: their events in events_raw and events_dev (and the anonymous
 *    rows of their devices, never another signed-in learner's), their facts, their identity
 *    rows and their person-level model rows. Aggregate models keep only counts and HLL
 *    sketches, which hold no id.
 * 3. Log the request in console_analytics_forgotten: the facts export then keeps them out,
 *    and `--scheduled` re-runs recent requests.
 *
 * BigQuery can't delete rows still in the streaming buffer (minutes to hours old), so events
 * of today and yesterday (IST) are left to the scheduled re-runs; retention needs no job:
 * events_raw partitions expire after 395 days (the DDL).
 */

export type Subject = { kind: 'appspot'; id: string } | { kind: 'td'; id: number }

export function parseSubject(raw: string): Subject {
  const s = String(raw ?? '').trim()
  if (/^\d{1,10}$/.test(s)) return { kind: 'td', id: Number(s) }
  if (/^[A-Za-z0-9_-]{8,64}$/.test(s)) return { kind: 'appspot', id: s }
  throw new Error('Give a teachers-dashboard users.id (digits) or an appspot _id (letters and digits, usually 24 hex characters)')
}

export interface Identity {
  appspotIds: string[]
  tdUserIds: number[]
}

export interface Resolved extends Identity {
  anonymousIds: string[]
}

const TYPES: QueryTypes = { appspot_ids: ['STRING'], td_user_ids: ['INT64'], anonymous_ids: ['STRING'], persons: ['STRING'] }

export function params(ids: Resolved) {
  return {
    appspot_ids: ids.appspotIds,
    td_user_ids: ids.tdUserIds,
    anonymous_ids: ids.anonymousIds,
    persons: [...ids.appspotIds, ...ids.anonymousIds.map((a) => `anon:${a}`)],
  }
}

export const identitiesLookupSql = (r: Refs) =>
  `SELECT appspot_id, td_user_id FROM ${r.t('identities')} WHERE appspot_id IN UNNEST(@appspot_ids) OR td_user_id IN UNNEST(@td_user_ids)`

/** The anonymous ids the learner's devices used: from the links, and from the raw events not modelled yet. */
export const anonymousIdsSql = (r: Refs) => `SELECT anonymous_id FROM ${r.t('m_identity_links')} WHERE user_id IN UNNEST(@appspot_ids)
UNION DISTINCT
SELECT anonymous_id FROM ${r.t('events_raw')} WHERE user_id IN UNNEST(@appspot_ids) AND anonymous_id IS NOT NULL
UNION DISTINCT
SELECT anonymous_id FROM ${r.t('events_dev')} WHERE user_id IN UNNEST(@appspot_ids) AND anonymous_id IS NOT NULL`

/** Rows older than yesterday (IST): the streaming buffer may still hold newer ones. */
export const SETTLED = "event_date < DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY)"

export interface Target {
  table: string
  where: string
}

/** Every table that can hold the learner's rows, and which of its rows are theirs. */
export function forgetTargets(): Target[] {
  const events = `(user_id IN UNNEST(@appspot_ids) OR (user_id IS NULL AND anonymous_id IN UNNEST(@anonymous_ids))) AND ${SETTLED}`
  const byTd = 'td_user_id IN UNNEST(@td_user_ids)'
  return [
    { table: 'events_raw', where: events },
    { table: 'events_dev', where: events },
    { table: 'fact_users', where: byTd },
    { table: 'fact_bookings', where: byTd },
    { table: 'fact_payments', where: byTd },
    { table: 'fact_class_attendance', where: byTd },
    { table: 'fact_quiz_attempts', where: byTd },
    { table: 'fact_tutor_sessions', where: byTd },
    { table: 'identities', where: `appspot_id IN UNNEST(@appspot_ids) OR ${byTd}` },
    { table: 'm_sessions', where: 'user_id IN UNNEST(@appspot_ids) OR (user_id IS NULL AND anonymous_id IN UNNEST(@anonymous_ids))' },
    { table: 'm_funnel_steps', where: 'user_id IN UNNEST(@appspot_ids) OR person IN UNNEST(@persons)' },
    { table: 'm_user_firsts', where: 'user_id IN UNNEST(@appspot_ids)' },
    // Last: the links are how the anonymous ids were found.
    { table: 'm_identity_links', where: 'user_id IN UNNEST(@appspot_ids)' },
  ]
}

export const deleteSql = (r: Refs, t: Target) => `DELETE FROM ${r.t(t.table)} WHERE ${t.where}`
export const countSql = (r: Refs, t: Target) => `SELECT COUNT(*) AS n FROM ${r.t(t.table)} WHERE ${t.where}`

export interface ForgetDeps {
  warehouse: Warehouse
  refs: Refs
  /** Ids from MySQL learner_accounts (sign-in v2), when it exists. */
  accounts?: (ids: Identity) => Promise<Identity>
  log?: (line: string) => void
}

const uniq = <T>(items: T[]) => [...new Set(items)]

export async function resolveIds(subject: Subject, deps: ForgetDeps): Promise<Resolved> {
  let ids: Identity = subject.kind === 'appspot' ? { appspotIds: [subject.id], tdUserIds: [] } : { appspotIds: [], tdUserIds: [subject.id] }
  const merge = (more: Identity) => {
    ids = { appspotIds: uniq([...ids.appspotIds, ...more.appspotIds]), tdUserIds: uniq([...ids.tdUserIds, ...more.tdUserIds]) }
  }
  if (deps.accounts) merge(await deps.accounts(ids))
  try {
    const rows = await deps.warehouse.query(identitiesLookupSql(deps.refs), params({ ...ids, anonymousIds: [] }), TYPES)
    merge({
      appspotIds: rows.map((r) => r.appspot_id).filter((v): v is string => typeof v === 'string' && !!v),
      tdUserIds: rows.map((r) => Number(r.td_user_id)).filter((v) => Number.isInteger(v) && v > 0),
    })
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  let anonymousIds: string[] = []
  if (ids.appspotIds.length) {
    try {
      const rows = await deps.warehouse.query(anonymousIdsSql(deps.refs), params({ ...ids, anonymousIds: [] }), TYPES)
      anonymousIds = uniq(rows.map((r) => r.anonymous_id).filter((v): v is string => typeof v === 'string' && !!v))
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  return { ...ids, anonymousIds }
}

export interface ForgetResult {
  ids: Resolved
  /** Rows per table: deleted (or, in a dry run, that would be); null = BigQuery didn't say; 'missing' = no such table. */
  tables: { table: string; rows: number | null | 'missing' }[]
  dryRun: boolean
}

export async function forgetLearner(subject: Subject, deps: ForgetDeps & { dryRun: boolean }): Promise<ForgetResult> {
  const log = deps.log ?? (() => {})
  const ids = await resolveIds(subject, deps)
  const p = params(ids)
  log(`resolved: ${ids.appspotIds.length} app user id(s), ${ids.tdUserIds.length} teachers-dashboard id(s), ${ids.anonymousIds.length} device id(s)`)
  const tables: ForgetResult['tables'] = []
  for (const target of forgetTargets()) {
    try {
      if (deps.dryRun) {
        const [row] = await deps.warehouse.query(countSql(deps.refs, target), p, TYPES)
        tables.push({ table: target.table, rows: Number((row?.n as { value?: unknown })?.value ?? row?.n ?? 0) })
      } else {
        const { affectedRows } = await deps.warehouse.execute(deleteSql(deps.refs, target), p, TYPES)
        tables.push({ table: target.table, rows: affectedRows })
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
      tables.push({ table: target.table, rows: 'missing' })
    }
    const last = tables[tables.length - 1]
    log(`${target.table}: ${last.rows === 'missing' ? 'no such table' : `${last.rows ?? '?'} row(s) ${deps.dryRun ? 'would be deleted' : 'deleted'}`}`)
  }
  return { ids, tables, dryRun: deps.dryRun }
}

// ------------------------------------------------------------------ MySQL: accounts, the log, suppression

const LOG = 'console_analytics_forgotten'

async function hasTable(connection: 'mysql' | 'analytics', table: string, column?: string) {
  const q = db.connection(connection).from('information_schema.columns').whereRaw('table_schema = DATABASE()').where('table_name', table)
  if (column) q.where('column_name', column)
  const row = await q.count('* as n').first()
  return Number(row?.n ?? 0) > 0
}

/** The learner's ids in MySQL learner_accounts (sign-in v2), when that table exists. */
export async function accountsFromMysql(ids: Identity): Promise<Identity> {
  if (!ids.appspotIds.length && !ids.tdUserIds.length) return { appspotIds: [], tdUserIds: [] }
  if (!(await hasTable('analytics', 'learner_accounts'))) return { appspotIds: [], tdUserIds: [] }
  const appspot = (await hasTable('analytics', 'learner_accounts', 'appspot_user_id')) ? 'appspot_user_id' : 'appspot_id'
  if (!(await hasTable('analytics', 'learner_accounts', appspot))) return { appspotIds: [], tdUserIds: [] }
  const rows = await db
    .connection('analytics')
    .from('learner_accounts')
    .where((q) => {
      if (ids.appspotIds.length) q.orWhereIn(appspot, ids.appspotIds)
      if (ids.tdUserIds.length) q.orWhereIn('td_user_id', ids.tdUserIds)
    })
    .select(`${appspot} as appspot_id`, 'td_user_id')
  return {
    appspotIds: rows.map((r) => r.appspot_id).filter(Boolean).map(String),
    tdUserIds: rows.map((r) => Number(r.td_user_id)).filter((v) => Number.isInteger(v) && v > 0),
  }
}

export async function logForget(result: ForgetResult, source: 'command' | 'deleted_account' | 'rerun') {
  if (!(await hasTable('mysql', LOG))) return false
  const deleted = Object.fromEntries(result.tables.map((t) => [t.table, t.rows]))
  const n = Math.max(1, result.ids.appspotIds.length, result.ids.tdUserIds.length)
  await db
    .insertQuery()
    .table(LOG)
    .multiInsert(
      Array.from({ length: n }, (_, i) => ({
        td_user_id: result.ids.tdUserIds[i] ?? null,
        appspot_id: result.ids.appspotIds[i] ?? null,
        source,
        deleted: i === 0 ? JSON.stringify(deleted) : null,
        created_at: new Date(),
      }))
    )
  return true
}

/** Everyone ever forgotten: the facts export leaves them out. */
export async function forgottenIds(): Promise<{ tdUserIds: Set<number>; appspotIds: Set<string> }> {
  if (!(await hasTable('mysql', LOG))) return { tdUserIds: new Set(), appspotIds: new Set() }
  const rows = await db.from(LOG).distinct('td_user_id', 'appspot_id')
  return {
    tdUserIds: new Set(rows.map((r) => Number(r.td_user_id)).filter((v) => Number.isInteger(v) && v > 0)),
    appspotIds: new Set(rows.map((r) => r.appspot_id).filter(Boolean).map(String)),
  }
}

/** How many days the scheduled job keeps re-running a request (past the streaming buffer). */
export const RERUN_DAYS = 7

/**
 * The scheduled job's work list: accounts deleted in sign-in v2 in the last RERUN_DAYS days,
 * and every request logged in that time (re-run for the events that were still streaming).
 */
export async function scheduledSubjects(now = Date.now()): Promise<{ subject: Subject; source: 'deleted_account' | 'rerun' }[]> {
  const since = new Date(now - RERUN_DAYS * 86_400_000)
  const out = new Map<string, { subject: Subject; source: 'deleted_account' | 'rerun' }>()
  if ((await hasTable('mysql', LOG))) {
    for (const r of await db.from(LOG).where('created_at', '>=', since).distinct('td_user_id', 'appspot_id')) {
      if (r.appspot_id) out.set(`a:${r.appspot_id}`, { subject: { kind: 'appspot', id: String(r.appspot_id) }, source: 'rerun' })
      else if (r.td_user_id) out.set(`t:${r.td_user_id}`, { subject: { kind: 'td', id: Number(r.td_user_id) }, source: 'rerun' })
    }
  }
  if ((await hasTable('analytics', 'learner_accounts', 'status')) && (await hasTable('analytics', 'learner_accounts', 'updated_at'))) {
    const appspot = (await hasTable('analytics', 'learner_accounts', 'appspot_user_id')) ? 'appspot_user_id' : 'appspot_id'
    const rows = await db.connection('analytics').from('learner_accounts').where('status', 'deleted').where('updated_at', '>=', since).select(`${appspot} as appspot_id`)
    for (const r of rows) {
      if (r.appspot_id && !out.has(`a:${r.appspot_id}`)) out.set(`a:${r.appspot_id}`, { subject: { kind: 'appspot', id: String(r.appspot_id) }, source: 'deleted_account' })
    }
  }
  return [...out.values()]
}
