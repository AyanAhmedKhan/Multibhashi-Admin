import { istDayLabel, istDayOf } from '#helpers/ist'
import { ProviderError, clip, mergeRows, num, type ProviderRow } from '#services/analytics/provider_types'

/**
 * OpenAI's organisation Usage and Costs APIs (an Admin key, not a normal API key):
 * - GET /v1/organization/usage/completions — tokens and requests per day, grouped by
 *   model, project and API key. `input_tokens` INCLUDES cached tokens, so the row we keep
 *   as `input_tokens` is the uncached part (input_tokens − input_cached_tokens), the same
 *   convention as the tutor's usage (docs/AI_USAGE_SPEC.md);
 * - GET /v1/organization/costs — what OpenAI actually charged per day (USD), grouped by
 *   project, line item and API key (bucket_width 1d only).
 * The console syncs the whole organisation; which project/key is the quiz backend is decided
 * at read time (cost_attribution.ts).
 * Both are paged (`has_more`, `next_page`). Daily buckets are UTC days; each is labelled with
 * the IST date of its start (00:00 UTC = 05:30 IST), so "a day" here runs 05:30–05:30 IST.
 * The HTTP client is injectable so tests run on fixtures and never call OpenAI.
 */

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

export interface OpenAiUsageOptions {
  adminKey: string
  /** Narrow to the quiz backend's project(s) / key(s); empty = the whole organisation. */
  projectIds?: string[]
  apiKeyIds?: string[]
  fetch?: FetchLike
  baseUrl?: string
  timeoutMs?: number
}

interface Bucket {
  start_time?: number
  end_time?: number
  results?: Record<string, unknown>[]
}

interface Page {
  data?: Bucket[]
  has_more?: boolean
  next_page?: string | null
}

const dayOf = (seconds: number) => istDayLabel(istDayOf(seconds * 1000))
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

/** Usage API pages → per-day rows: uncached input, cached input, output tokens, requests. */
export function parseCompletionsUsage(pages: Page[]): ProviderRow[] {
  const rows: ProviderRow[] = []
  for (const page of pages) {
    for (const bucket of page.data ?? []) {
      if (typeof bucket.start_time !== 'number') continue
      const day = dayOf(bucket.start_time)
      for (const r of bucket.results ?? []) {
        if (r.object !== undefined && r.object !== 'organization.usage.completions.result') continue
        const scope = clip(`${str(r.project_id) ?? 'all-projects'}/${str(r.api_key_id) ?? 'all-keys'}`, 160)
        const item = clip(str(r.model) ?? 'unknown-model', 255)
        const input = num(r.input_tokens)
        const cached = num(r.input_cached_tokens)
        // Newer responses also split out the uncached part; older ones only the total.
        const uncached = r.input_uncached_tokens !== undefined && r.input_uncached_tokens !== null ? num(r.input_uncached_tokens) : Math.max(0, input - cached)
        const base = { day, provider: 'openai' as const, scope, item, costUsd: 0, creditsUsd: 0, source: 'openai_usage_api' as const }
        rows.push(
          { ...base, unit: 'input_tokens', quantity: uncached },
          { ...base, unit: 'cached_input_tokens', quantity: cached },
          { ...base, unit: 'output_tokens', quantity: num(r.output_tokens) },
          { ...base, unit: 'requests', quantity: num(r.num_model_requests) }
        )
      }
    }
  }
  return mergeRows(rows).filter((r) => r.quantity > 0)
}

/**
 * Costs API pages → per-day rows carrying OpenAI's own charge (USD) per line item. Grouped by
 * key too (`byKey`), the scope is "project/key" like the usage rows; otherwise just the project.
 */
export function parseCosts(pages: Page[], byKey = false): ProviderRow[] {
  const rows: ProviderRow[] = []
  for (const page of pages) {
    for (const bucket of page.data ?? []) {
      if (typeof bucket.start_time !== 'number') continue
      const day = dayOf(bucket.start_time)
      for (const r of bucket.results ?? []) {
        if (r.object !== undefined && r.object !== 'organization.costs.result') continue
        const amount = (r.amount ?? {}) as { value?: unknown; currency?: unknown }
        const currency = String(amount.currency ?? 'usd').toLowerCase()
        if (currency !== 'usd') throw new ProviderError(`OpenAI reported costs in ${currency.toUpperCase()}, expected USD`)
        rows.push({
          day,
          provider: 'openai',
          scope: clip(byKey ? `${str(r.project_id) ?? 'all-projects'}/${str(r.api_key_id) ?? 'no-key'}` : (str(r.project_id) ?? 'all-projects'), 160),
          item: clip(str(r.line_item) ?? 'all line items', 255),
          unit: clip(str(r.quantity_unit) ?? 'usd', 48),
          quantity: num(r.quantity),
          costUsd: num(amount.value),
          creditsUsd: 0,
          source: 'openai_costs_api',
        })
      }
    }
  }
  return mergeRows(rows).filter((r) => r.costUsd !== 0 || r.quantity > 0)
}

/** The OpenAI SDK's query format: arrays as `key[]=a&key[]=b`. */
function query(params: Record<string, string | number | string[] | undefined>) {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) q.append(`${key}[]`, v)
    else q.append(key, String(value))
  }
  return q.toString()
}

export class OpenAiUsageClient {
  #fetch: FetchLike
  #base: string

  constructor(private opts: OpenAiUsageOptions) {
    this.#fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
    this.#base = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '')
  }

  private async pages(path: string, params: Record<string, string | number | string[] | undefined>, maxPages = 20): Promise<Page[]> {
    const pages: Page[] = []
    let page: string | undefined
    for (let i = 0; i < maxPages; i++) {
      const url = `${this.#base}${path}?${query({ ...params, page })}`
      const res = await this.#fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.opts.adminKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      })
      const text = await res.text()
      let body: unknown = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      if (!res.ok) {
        const message = (body as { error?: { message?: string } } | null)?.error?.message
        const hint = res.status === 401 || res.status === 403 ? ' (an organisation Admin key with usage read access is needed)' : ''
        throw new ProviderError(`OpenAI ${path} answered ${res.status}${message ? `: ${message.slice(0, 200)}` : ''}${hint}`, res.status)
      }
      const p = (body ?? {}) as Page
      pages.push(p)
      if (!p.has_more || !p.next_page) break
      page = p.next_page
    }
    return pages
  }

  /** Tokens and requests per day since `startTime` (Unix seconds). */
  async completions(startTime: number, days: number) {
    const pages = await this.pages('/v1/organization/usage/completions', {
      start_time: startTime,
      bucket_width: '1d',
      limit: Math.min(31, Math.max(1, days)),
      group_by: ['model', 'project_id', 'api_key_id'],
      project_ids: this.opts.projectIds?.length ? this.opts.projectIds : undefined,
      api_key_ids: this.opts.apiKeyIds?.length ? this.opts.apiKeyIds : undefined,
    })
    return parseCompletionsUsage(pages)
  }

  /**
   * OpenAI's charges per day since `startTime` (Unix seconds), per project, line item and API
   * key. The API refuses some group_by combinations (HTTP 400); then the key is dropped and the
   * costs come per project and line item only (`byKey: false`).
   */
  async costs(startTime: number, days: number): Promise<{ rows: ProviderRow[]; byKey: boolean }> {
    const params = (groupBy: string[]) => ({
      start_time: startTime,
      bucket_width: '1d',
      limit: Math.min(180, Math.max(1, days)),
      group_by: groupBy,
      project_ids: this.opts.projectIds?.length ? this.opts.projectIds : undefined,
      api_key_ids: this.opts.apiKeyIds?.length ? this.opts.apiKeyIds : undefined,
    })
    try {
      return { rows: parseCosts(await this.pages('/v1/organization/costs', params(['project_id', 'line_item', 'api_key_id'])), true), byKey: true }
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 400) throw error
      return { rows: parseCosts(await this.pages('/v1/organization/costs', params(['project_id', 'line_item']))), byKey: false }
    }
  }
}
