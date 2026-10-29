import { ProviderError, clip, mergeRows, num, type ProviderRow } from '#services/analytics/provider_types'

/**
 * The GCP Cloud Billing export to BigQuery (standard usage cost table,
 * `project.dataset.gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`). Columns used, as documented
 * by Google: usage_start_time / usage_end_time (TIMESTAMP, hourly windows), project.id,
 * service.description, sku.description, usage.amount, usage.unit, cost (FLOAT, in the
 * billing account's `currency`), currency_conversion_rate (USD → that currency),
 * credits (REPEATED: amount, negative), export_time.
 *
 * Net cost = cost + Σ credits.amount, converted to USD by ÷ currency_conversion_rate.
 * Rows are grouped per IST day of usage_start_time, service and SKU for the speech project
 * only. Which SKUs are speech-to-text is decided by `isSpeechSku`, not by a service name:
 * Google's price page names the Speech-to-Text SKUs "Recognition" (V2, sku 3099-B70F-0949),
 * "Speech Recognition (with/without data logging)" (V1) and "Dynamic Batch Recognition";
 * every other SKU of the project is kept and shown, but not counted as quiz cost.
 * The BigQuery client is injectable so tests run on fixtures.
 */

export interface BigQueryLike {
  query(options: { query: string; params?: Record<string, unknown> }): Promise<unknown[]>
}

export interface BillingReaderOptions {
  /** `project.dataset.gcp_billing_export_v1_…` */
  table: string
  /** GCP project whose speech-to-text is billed (multibhashi-android-app). */
  projectId: string
  client: BigQueryLike
}

export interface BillingResult {
  rows: ProviderRow[]
  /** Latest usage_end_time in the export for this project: days ending before it are complete. */
  dataThrough: string | null
  exportedAt: string | null
}

/** Billing-export table ids are project.dataset.table; refuse anything else (it goes into SQL). */
const TABLE = /^[a-z][a-z0-9.:-]{3,100}\.[A-Za-z0-9_]{1,1024}\.[A-Za-z0-9_]{1,1024}$/
const PROJECT = /^[a-z][a-z0-9.:-]{3,100}$/

export function validTable(table: string) {
  return TABLE.test(table)
}

/** Speech-to-text SKUs as named on Google's Speech-to-Text price page (checked 29 Oct 2026). */
export function isSpeechSku(item: string) {
  const sku = item.includes(' / ') ? item.slice(item.indexOf(' / ') + 3) : item
  return /\brecognition\b/i.test(sku)
}

export function billingQuery(table: string) {
  if (!validTable(table)) throw new ProviderError('GCP_BILLING_EXPORT_TABLE must look like project.dataset.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX')
  const rate = 'IF(currency_conversion_rate IS NULL OR currency_conversion_rate = 0, 1, currency_conversion_rate)'
  return `
SELECT
  FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time, 'Asia/Kolkata')) AS usage_day,
  project.id AS project_id,
  service.description AS service,
  sku.description AS sku,
  IFNULL(usage.unit, '') AS unit,
  SUM(IFNULL(usage.amount, 0)) AS quantity,
  SUM(cost / ${rate}) AS cost_usd,
  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0) / ${rate}) AS credits_usd,
  MAX(usage_end_time) AS usage_through,
  MAX(export_time) AS exported_at
FROM \`${table}\`
WHERE project.id = @project
  AND usage_start_time >= TIMESTAMP(@since_day, 'Asia/Kolkata')
GROUP BY usage_day, project_id, service, sku, unit`
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const raw = typeof v === 'object' && 'value' in (v as object) ? (v as { value: unknown }).value : v
  const d = new Date(String(raw))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** BigQuery result rows → provider rows (+ how far the export has got). */
export function parseBillingRows(raw: Record<string, unknown>[]): BillingResult {
  const rows: ProviderRow[] = []
  let dataThrough: string | null = null
  let exportedAt: string | null = null
  for (const r of raw) {
    const day = String(r.usage_day ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    const service = String(r.service ?? 'unknown service')
    const sku = String(r.sku ?? 'unknown SKU')
    rows.push({
      day,
      provider: 'google',
      scope: clip(String(r.project_id ?? 'unknown-project'), 160),
      item: clip(`${service} / ${sku}`, 255),
      unit: clip(String(r.unit || 'none'), 48),
      quantity: num(r.quantity),
      costUsd: num(r.cost_usd) + num(r.credits_usd),
      source: 'gcp_billing_export',
    })
    const through = iso(r.usage_through)
    if (through && (!dataThrough || through > dataThrough)) dataThrough = through
    const exported = iso(r.exported_at)
    if (exported && (!exportedAt || exported > exportedAt)) exportedAt = exported
  }
  return { rows: mergeRows(rows), dataThrough, exportedAt }
}

export class BillingReader {
  constructor(private opts: BillingReaderOptions) {
    if (!PROJECT.test(opts.projectId)) throw new ProviderError('GCP_SPEECH_PROJECT_ID is not a valid project id')
  }

  /** Every SKU billed to the speech project since `sinceDay` (IST, YYYY-MM-DD). */
  async read(sinceDay: string): Promise<BillingResult> {
    let result: unknown[]
    try {
      result = await this.opts.client.query({ query: billingQuery(this.opts.table), params: { project: this.opts.projectId, since_day: sinceDay } })
    } catch (error) {
      if (error instanceof ProviderError) throw error
      const e = error as { code?: number; message?: string }
      throw new ProviderError(`BigQuery: ${String(e.message ?? error).slice(0, 300)}`, typeof e.code === 'number' ? e.code : null)
    }
    const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : []) as Record<string, unknown>[]
    return parseBillingRows(rows)
  }
}

/** The real BigQuery client, loaded only when billing is configured. */
export async function bigQueryClient(credentials: { project_id?: string; client_email?: string; private_key?: string }): Promise<BigQueryLike> {
  const { BigQuery } = await import('@google-cloud/bigquery')
  const bq = new BigQuery({
    projectId: credentials.project_id,
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
  })
  return { query: (options) => bq.query(options) as Promise<unknown[]> }
}
