import { ProviderError, clip, mergeRows, num, type ProviderRow } from '#services/analytics/provider_types'

/**
 * The GCP Cloud Billing export to BigQuery (standard usage cost table,
 * `project.dataset.gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`): the WHOLE billing account,
 * every project, service and SKU. Columns used, as documented by Google:
 * usage_start_time / usage_end_time (TIMESTAMP, hourly windows), project.id,
 * service.description, sku.description, usage.amount, usage.unit, cost (FLOAT, in the
 * billing account's `currency`), currency_conversion_rate (USD → that currency),
 * credits (REPEATED: amount, negative), export_time.
 *
 * Gross = cost and credits = Σ credits.amount are kept apart (net = gross + credits), both
 * converted to USD by ÷ currency_conversion_rate, grouped per IST day of usage_start_time,
 * project, service, SKU and unit. Rows without a project (taxes, account-level charges) keep
 * the scope "no-project". What is quiz speech-to-text, AI tutor or anything else is decided
 * at read time (cost_attribution.ts), never by filtering here. The BigQuery client is
 * injectable so tests run on fixtures.
 */

export const NO_PROJECT = 'no-project'

export interface BigQueryLike {
  query(options: { query: string; params?: Record<string, unknown> }): Promise<unknown[]>
}

export interface BillingReaderOptions {
  /** `project.dataset.gcp_billing_export_v1_…` */
  table: string
  client: BigQueryLike
}

export interface BillingResult {
  rows: ProviderRow[]
  /** Latest usage_end_time in the export: days ending before it are complete. */
  dataThrough: string | null
  exportedAt: string | null
}

/** Billing-export table ids are project.dataset.table; refuse anything else (it goes into SQL). */
const TABLE = /^[a-z][a-z0-9.:-]{3,100}\.[A-Za-z0-9_]{1,1024}\.[A-Za-z0-9_]{1,1024}$/

export function validTable(table: string) {
  return TABLE.test(table)
}

/**
 * Speech-to-text line items. The price page says "recognition"; the real export (checked
 * 30 Oct 2026) bills it as service "Cloud Speech API", SKU "Cloud Speech-to-Text Audio
 * Length Standard". Text-to-speech ("Cloud Text-to-Speech API") never matches.
 */
export function isSpeechSku(item: string) {
  const { service, sku } = splitItem(item)
  return /\brecognition\b|speech-to-text/i.test(sku) || /^cloud speech\b/i.test(service)
}

/** "Service / SKU" → its two halves. */
export function splitItem(item: string) {
  const i = item.indexOf(' / ')
  return i < 0 ? { service: item, sku: '' } : { service: item.slice(0, i), sku: item.slice(i + 3) }
}

/** The FOCUS-format export (`gcp_billing_export_focus_<BILLING_ACCOUNT_ID>`), as opposed to the standard one. */
export function isFocusTable(table: string) {
  return /(^|\.)gcp_billing_export_focus_[A-Za-z0-9_]+$/.test(table)
}

/**
 * The same rows from Google's FOCUS export, which a linked dataset provides with history
 * (the standard export starts only on the day it is enabled). Mapping, checked against the
 * real table on 30 Oct 2026: ChargePeriodStart → day, x_Project.Id → project, ServiceName →
 * service, ChargeDescription → SKU, ConsumedQuantity/ConsumedUnit → usage,
 * x_CurrencyConversionRate (billing currency per USD). BilledCost is already NET of credits
 * (ListCost − credits = BilledCost to the paisa), so gross = BilledCost − Σ x_Credits.Amount.
 */
function focusQuery(table: string) {
  const rate = 'IF(x_CurrencyConversionRate IS NULL OR x_CurrencyConversionRate = 0, 1, x_CurrencyConversionRate)'
  const credits = 'IFNULL((SELECT SUM(CAST(c.Amount AS FLOAT64)) FROM UNNEST(x_Credits) AS c), 0)'
  return `
SELECT
  FORMAT_DATE('%Y-%m-%d', DATE(ChargePeriodStart, 'Asia/Kolkata')) AS usage_day,
  IFNULL(x_Project.Id, IFNULL(SubAccountId, '${NO_PROJECT}')) AS project_id,
  IFNULL(ServiceName, 'unknown service') AS service,
  IFNULL(ChargeDescription, IFNULL(SkuId, 'unknown SKU')) AS sku,
  IFNULL(ConsumedUnit, IFNULL(PricingUnit, '')) AS unit,
  SUM(CAST(IFNULL(ConsumedQuantity, 0) AS FLOAT64)) AS quantity,
  SUM((CAST(IFNULL(BilledCost, 0) AS FLOAT64) - ${credits}) / ${rate}) AS cost_usd,
  SUM(${credits} / ${rate}) AS credits_usd,
  MAX(ChargePeriodEnd) AS usage_through,
  MAX(x_ExportTime) AS exported_at
FROM \`${table}\`
WHERE ChargePeriodStart >= TIMESTAMP(@since_day, 'Asia/Kolkata')
GROUP BY usage_day, project_id, service, sku, unit`
}

export function billingQuery(table: string) {
  if (!validTable(table)) throw new ProviderError('GCP_BILLING_EXPORT_TABLE must look like project.dataset.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX (or …_focus_…)')
  if (isFocusTable(table)) return focusQuery(table)
  const rate = 'IF(currency_conversion_rate IS NULL OR currency_conversion_rate = 0, 1, currency_conversion_rate)'
  return `
SELECT
  FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time, 'Asia/Kolkata')) AS usage_day,
  IFNULL(project.id, '${NO_PROJECT}') AS project_id,
  IFNULL(service.description, 'unknown service') AS service,
  IFNULL(sku.description, 'unknown SKU') AS sku,
  IFNULL(usage.unit, '') AS unit,
  SUM(IFNULL(usage.amount, 0)) AS quantity,
  SUM(IFNULL(cost, 0) / ${rate}) AS cost_usd,
  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0) / ${rate}) AS credits_usd,
  MAX(usage_end_time) AS usage_through,
  MAX(export_time) AS exported_at
FROM \`${table}\`
WHERE usage_start_time >= TIMESTAMP(@since_day, 'Asia/Kolkata')
GROUP BY usage_day, project_id, service, sku, unit`
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const raw = typeof v === 'object' && 'value' in (v as object) ? (v as { value: unknown }).value : v
  const d = new Date(String(raw))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const GIB = 1024 ** 3

/**
 * Storage is billed in byte-seconds and egress in bytes. A day of stored data reaches ~2e18
 * byte-seconds on this account (checked 30 Oct 2026), past the quantity column's DECIMAL(20,4),
 * and the whole sync failed on it. GiB-days and GiB fit easily and read better.
 */
export function normalizeUsage(unit: string, quantity: number): { unit: string; quantity: number } {
  if (unit === 'byte-seconds') return { unit: 'gibibyte-days', quantity: quantity / (GIB * 86_400) }
  if (unit === 'bytes') return { unit: 'gibibytes', quantity: quantity / GIB }
  return { unit, quantity }
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
    const usage = normalizeUsage(String(r.unit || 'none'), num(r.quantity))
    rows.push({
      day,
      provider: 'google',
      scope: clip(String(r.project_id || NO_PROJECT), 160),
      item: clip(`${service} / ${sku}`, 255),
      unit: clip(usage.unit, 48),
      quantity: usage.quantity,
      costUsd: num(r.cost_usd),
      creditsUsd: num(r.credits_usd),
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
  constructor(private opts: BillingReaderOptions) {}

  /** Every project, service and SKU on the billing account since `sinceDay` (IST, YYYY-MM-DD). */
  async read(sinceDay: string): Promise<BillingResult> {
    let result: unknown[]
    try {
      result = await this.opts.client.query({ query: billingQuery(this.opts.table), params: { since_day: sinceDay } })
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
