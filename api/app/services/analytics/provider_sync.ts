import { readFile } from 'node:fs/promises'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import { istDayLabel, istDayOf } from '#helpers/ist'
import { OpenAiUsageClient, type FetchLike } from '#services/analytics/openai_usage'
import { BillingReader, bigQueryClient, validTables, type BigQueryLike } from '#services/analytics/gcp_billing'
import { ProviderError, type ProviderRow } from '#services/analytics/provider_types'
import { TUTOR_GEMINI_PROJECT, describeRules, type AttributionRules } from '#services/analytics/cost_attribution'

/**
 * Pulls the providers' own daily usage and billing into console_ai_provider_daily
 * (docs/QUIZ_OBSERVABILITY.md §3): the WHOLE bill, unfiltered — every OpenAI project, key and
 * model, every GCP project, service and SKU on the billing account. What is quizzes, AI tutor
 * or anything else is decided at read time (cost_attribution.ts). Run daily by `quiz:sync-provider-usage --days N` (system
 * cron) and by the Cost page's Refresh. Each successful fetch REPLACES its window for that
 * source in one transaction (upsert on the unique key, rows the provider no longer reports
 * removed), so re-running is idempotent. A provider without credentials is "not connected":
 * a status, never an error. Credentials are never logged or returned.
 */

const TABLE = 'console_ai_provider_daily'
const STATUS_KEY = 'quiz_provider_sync'
export const MAX_SYNC_DAYS = 90

type Get = (key: string) => string | undefined

export interface GoogleCredentials {
  project_id?: string
  client_email?: string
  private_key?: string
}

export interface ProviderConfig {
  /** projectIds / apiKeyIds: the quiz backend's, an attribution rule (not a sync filter). */
  openai: { connected: boolean; missing: string[]; adminKey?: string; projectIds: string[]; apiKeyIds: string[] }
  /** projectId: the speech-to-text project, an attribution rule (not a sync filter). */
  google: { connected: boolean; missing: string[]; problem?: string; table?: string; projectId?: string; credentials?: GoogleCredentials }
}

export interface ProviderRunStatus {
  at: string
  ok: boolean
  error: string | null
  rows: number
  days: number
  /** Usage up to this instant is in: days that end before it are complete. */
  dataThrough: string | null
  exportedAt?: string | null
  /** Rows written by console:seed-demo (local only), not by a provider. */
  demo?: boolean
  /** OpenAI: whether the Costs API accepted grouping by API key (else per project only). */
  costsByKey?: boolean
}

export type SyncStatus = Partial<Record<'openai' | 'google', ProviderRunStatus>>

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

function parseCredentials(raw: string): GoogleCredentials {
  const attempt = (text: string) => JSON.parse(text) as GoogleCredentials
  try {
    return attempt(raw)
  } catch {
    return attempt(Buffer.from(raw, 'base64').toString('utf8'))
  }
}

/** What is configured, and what is missing (by env name only). */
export async function readProviderConfig(get: Get = (k) => env.get(k as never) as string | undefined): Promise<ProviderConfig> {
  const adminKey = get('OPENAI_ADMIN_KEY')
  const openai = {
    connected: !!adminKey,
    missing: adminKey ? [] : ['OPENAI_ADMIN_KEY'],
    adminKey,
    projectIds: list(get('OPENAI_QUIZ_PROJECT_ID')),
    apiKeyIds: list(get('OPENAI_QUIZ_API_KEY_IDS')),
  }

  const missing: string[] = []
  let problem: string | undefined
  let credentials: GoogleCredentials | undefined
  const json = get('GCP_BILLING_CREDENTIALS_JSON')
  const file = get('GCP_BILLING_CREDENTIALS_FILE')
  if (!json && !file) missing.push('GCP_BILLING_CREDENTIALS_JSON (or GCP_BILLING_CREDENTIALS_FILE)')
  else {
    try {
      credentials = parseCredentials(json ?? (await readFile(file!, 'utf8')))
      if (!credentials.client_email || !credentials.private_key) problem = 'The GCP credentials are not a service-account key (client_email / private_key missing)'
    } catch {
      problem = json ? 'GCP_BILLING_CREDENTIALS_JSON is not valid JSON (or base64 JSON)' : 'GCP_BILLING_CREDENTIALS_FILE could not be read as a JSON key file'
      credentials = undefined
    }
  }
  const table = get('GCP_BILLING_EXPORT_TABLE')
  if (!table) missing.push('GCP_BILLING_EXPORT_TABLE')
  else if (!validTables(table)) problem = problem ?? 'GCP_BILLING_EXPORT_TABLE must be project.dataset.gcp_billing_export_v1_… (or gcp_billing_export_focus_…), several allowed comma-separated'
  // Attribution only: not needed to connect
  const projectId = get('GCP_SPEECH_PROJECT_ID')
  return {
    openai,
    google: { connected: !missing.length && !problem, missing, problem, table, projectId, credentials },
  }
}

/** The read-time attribution rules from the configuration. */
export function rulesFrom(config: ProviderConfig): AttributionRules {
  return {
    speechProject: config.google.projectId ?? null,
    openaiQuizProjects: config.openai.projectIds,
    openaiQuizKeys: config.openai.apiKeyIds,
    tutorGcpProjects: [TUTOR_GEMINI_PROJECT],
  }
}

export interface SyncDeps {
  config?: ProviderConfig
  fetch?: FetchLike
  bigquery?: BigQueryLike
  now?: number
}

export interface SyncResult {
  days: number
  openai: ProviderRunStatus | { connected: false; missing: string[] }
  google: ProviderRunStatus | { connected: false; missing: string[]; problem?: string }
}

const message = (error: unknown) =>
  error instanceof ProviderError ? error.message : `Unexpected error: ${String((error as Error)?.message ?? error).slice(0, 200)}`

class ProviderSync {
  #running: Promise<SyncResult> | null = null

  /** The last run per provider (console_settings; written only by the sync). */
  async lastRuns(): Promise<SyncStatus> {
    const row = await db.from('console_settings').where('key', STATUS_KEY).first()
    if (!row) return {}
    const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
    return (value ?? {}) as SyncStatus
  }

  private async saveRun(provider: 'openai' | 'google', run: ProviderRunStatus) {
    const current = await this.lastRuns()
    const next = { ...current, [provider]: run }
    await db
      .insertQuery()
      .table('console_settings')
      .insert({ key: STATUS_KEY, value: JSON.stringify(next), updated_by: null, updated_at: new Date() })
      .knexQuery.onConflict('key')
      .merge()
  }

  /** Connection and freshness per provider, for the page (no secrets: names of missing settings only). */
  async status(config?: ProviderConfig) {
    const cfg = config ?? (await readProviderConfig())
    const runs = await this.lastRuns()
    const spans = await db
      .from(TABLE)
      .groupBy('provider')
      .select('provider', db.raw('DATE_FORMAT(MIN(day), "%Y-%m-%d") as earliest'), db.raw('DATE_FORMAT(MAX(day), "%Y-%m-%d") as latest'))
    const span = (p: string) => spans.find((s) => s.provider === p)
    const rules = rulesFrom(cfg)
    return {
      rules,
      attribution: describeRules(rules),
      openai: {
        connected: cfg.openai.connected,
        missing: cfg.openai.missing,
        quizScope: { projectIds: cfg.openai.projectIds, apiKeyIds: cfg.openai.apiKeyIds },
        lastRun: runs.openai ?? null,
        earliestDay: (span('openai')?.earliest as string) ?? null,
        latestDay: (span('openai')?.latest as string) ?? null,
      },
      google: {
        connected: cfg.google.connected,
        missing: cfg.google.missing,
        problem: cfg.google.problem ?? null,
        speechProject: cfg.google.projectId ?? null,
        lastRun: runs.google ?? null,
        earliestDay: (span('google')?.earliest as string) ?? null,
        latestDay: (span('google')?.latest as string) ?? null,
      },
    }
  }

  /** Replace one source's rows from `firstDay` with what the provider just reported. */
  async replaceWindow(provider: 'openai' | 'google', source: ProviderRow['source'], firstDay: string, rows: ProviderRow[], syncedAt: Date) {
    await db.transaction(async (trx) => {
      await trx.from(TABLE).where('provider', provider).where('source', source).where('day', '>=', firstDay).delete()
      for (let i = 0; i < rows.length; i += 500) {
        await trx
          .insertQuery()
          .table(TABLE)
          .multiInsert(
            rows.slice(i, i + 500).map((r) => ({
              day: r.day,
              provider: r.provider,
              scope: r.scope,
              item: r.item,
              unit: r.unit,
              quantity: Math.round(r.quantity * 10_000) / 10_000,
              cost_usd: Math.round(r.costUsd * 1_000_000) / 1_000_000,
              credits_usd: Math.round(r.creditsUsd * 1_000_000) / 1_000_000,
              source: r.source,
              synced_at: syncedAt,
            }))
          )
          .knexQuery.onConflict(['day', 'provider', 'scope', 'item', 'unit'])
          .merge(['quantity', 'cost_usd', 'credits_usd', 'source', 'synced_at'])
      }
    })
  }

  /** Sync the last `days` IST days from every connected provider. Concurrent calls share one run. */
  run(days: number, deps: SyncDeps = {}): Promise<SyncResult> {
    if (this.#running) return this.#running
    this.#running = this.#run(days, deps).finally(() => {
      this.#running = null
    })
    return this.#running
  }

  async #run(requested: number, deps: SyncDeps): Promise<SyncResult> {
    const days = Math.min(MAX_SYNC_DAYS, Math.max(1, Math.floor(requested) || 1))
    const config = deps.config ?? (await readProviderConfig())
    const now = deps.now ?? Date.now()
    const syncedAt = new Date(now)
    const firstDay = istDayLabel(istDayOf(now) - days + 1)
    const result: SyncResult = {
      days,
      openai: { connected: false, missing: config.openai.missing },
      google: { connected: false, missing: config.google.missing, problem: config.google.problem },
    }

    if (config.openai.connected) {
      // The whole organisation: the quiz project/keys are applied when reading
      const client = new OpenAiUsageClient({ adminKey: config.openai.adminKey!, fetch: deps.fetch })
      // OpenAI's daily buckets are UTC days, labelled with the IST date they start on.
      const startTime = Math.floor(Date.parse(`${firstDay}T00:00:00Z`) / 1000)
      const errors: string[] = []
      let rows = 0
      let fetchedAny = false
      let costsByKey: boolean | undefined
      for (const [source, fetchRows] of [
        ['openai_usage_api', () => client.completions(startTime, days)],
        [
          'openai_costs_api',
          async () => {
            const costs = await client.costs(startTime, days)
            costsByKey = costs.byKey
            return costs.rows
          },
        ],
      ] as const) {
        try {
          const fetched = await fetchRows()
          await this.replaceWindow('openai', source, firstDay, fetched, syncedAt)
          rows += fetched.length
          fetchedAny = true
        } catch (error) {
          errors.push(message(error))
        }
      }
      const previous = fetchedAny ? null : (await this.lastRuns()).openai
      const run: ProviderRunStatus = {
        at: syncedAt.toISOString(),
        ok: !errors.length,
        error: errors.join(' · ') || null,
        rows,
        days,
        dataThrough: fetchedAny ? syncedAt.toISOString() : (previous?.dataThrough ?? null),
        ...(costsByKey === undefined ? {} : { costsByKey }),
      }
      await this.saveRun('openai', run)
      result.openai = run
    }

    if (config.google.connected) {
      let run: ProviderRunStatus
      try {
        const client = deps.bigquery ?? (await bigQueryClient(config.google.credentials!))
        const reader = new BillingReader({ table: config.google.table!, client })
        const billing = await reader.read(firstDay)
        await this.replaceWindow('google', 'gcp_billing_export', firstDay, billing.rows, syncedAt)
        run = { at: syncedAt.toISOString(), ok: true, error: null, rows: billing.rows.length, days, dataThrough: billing.dataThrough, exportedAt: billing.exportedAt }
      } catch (error) {
        const previous = (await this.lastRuns()).google
        run = { at: syncedAt.toISOString(), ok: false, error: message(error), rows: 0, days, dataThrough: previous?.dataThrough ?? null, exportedAt: previous?.exportedAt ?? null }
      }
      await this.saveRun('google', run)
      result.google = run
    }
    return result
  }
}

export default new ProviderSync()
