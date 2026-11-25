/**
 * One row of `console_ai_provider_daily` (docs/QUIZ_OBSERVABILITY.md §3): what a provider
 * itself reported for one IST day, account scope, line item and unit.
 */
export interface ProviderRow {
  /** IST day, YYYY-MM-DD */
  day: string
  provider: 'openai' | 'google'
  scope: string
  item: string
  unit: string
  quantity: number
  /** Gross cost in USD, as the provider reports it. */
  costUsd: number
  /** Credits and discounts in USD (negative); net = costUsd + creditsUsd. */
  creditsUsd: number
  source: 'openai_usage_api' | 'openai_costs_api' | 'gcp_billing_export'
}

/** A provider answered with an error (bad key, missing permission, HTTP 4xx/5xx). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number | null = null
  ) {
    super(message)
  }
}

/** Rows with the same key (day, scope, item, unit) summed: the table's unique key. */
export function mergeRows(rows: ProviderRow[]): ProviderRow[] {
  const byKey = new Map<string, ProviderRow>()
  for (const r of rows) {
    const key = `${r.day}|${r.provider}|${r.scope}|${r.item}|${r.unit}`
    const cur = byKey.get(key)
    if (cur) {
      cur.quantity += r.quantity
      cur.costUsd += r.costUsd
      cur.creditsUsd += r.creditsUsd
    } else {
      byKey.set(key, { ...r })
    }
  }
  return [...byKey.values()]
}

/** A number from a provider payload (numbers, numeric strings, BigQuery Big/Numeric objects). */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const n = Number(typeof value === 'object' && 'value' in (value as object) ? (value as { value: unknown }).value : String(value))
  return Number.isFinite(n) ? n : 0
}

/** Trim to a column's width (item 255, scope 160, unit 48). */
export const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)
