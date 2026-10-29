import db from '@adonisjs/lucid/services/db'
import ApiException from '#exceptions/api_exception'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * The AI tutor rate card (v2). Two parts:
 * - `prices`: what each provider charges, keyed by (provider, model, unit) — the same keys
 *   the agent reports usage in (docs/AI_USAGE_SPEC.md). Recorded usage × price = exact cost.
 * - `assumptions`: usage per class minute, per engine — only for classes that have no
 *   recorded usage (older classes, or before the agent reports it). The Cost page shows
 *   the measured values next to them, so Finance can adopt them in one click.
 * Finance edits both (console_settings `cost_model`); every change is audited.
 *
 * Prices are effective-dated: a line with `from` takes over from the line before it
 * (same provider, model and unit) on that IST day, so every class is priced at the rate
 * in force when it ran, and a price change never rewrites past months.
 */

export type Engine = 'sarvam' | 'global' | 'gemini'
export const ENGINES: Engine[] = ['sarvam', 'global', 'gemini']

export interface PriceLine {
  id: string
  label: string
  provider: string
  /** Exact model id, or `*` for any model of this provider. */
  model: string
  unit: string
  /** Price for `per` units, in `currency`. */
  price: number
  currency: 'INR' | 'USD'
  per: number
  /** First IST day (YYYY-MM-DD) this price applies. Absent: since always. */
  from?: string
  source?: string
  note?: string
}

export interface CostModel {
  v: 2
  /** The defaults' `checkedOn` this model was built from: older means newer official prices exist. */
  basedOn?: string
  usdToInr: number
  /** What a learner pays per AI tutor minute (₹100 per 30-minute block today). */
  pricePerPaidMinuteInr: number
  /** Engine assumed for classes whose language isn't known. */
  defaultEngine: Engine
  prices: PriceLine[]
  assumptions: Record<Engine, { label: string; usage: { priceId: string; perMinute: number }[] }>
  /** Monthly fixed costs (agent servers, monitoring) spread over the period. */
  fixedMonthly: { label: string; amountInr: number }[]
  checkedOn: string
}

const SARVAM = 'https://www.sarvam.ai/api-pricing'
const SARVAM_V4 = 'https://www.sarvam.ai/blogs/bulbul-v4-flash/'
const LIVEKIT = 'https://livekit.com/pricing'
const GEMINI = 'https://ai.google.dev/gemini-api/docs/pricing'
const REALTIME_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025'
/** Prices checked against the providers' pages on this day; USD at the Wise mid-market rate. */
const CHECKED_ON = '2026-10-29'

/** Human units for quantities (audio hours, characters, tokens…). */
export const UNIT_LABEL: Record<string, string> = {
  audio_seconds: 'audio seconds',
  characters: 'characters',
  input_tokens: 'input tokens',
  cached_input_tokens: 'cached input tokens',
  output_tokens: 'output tokens',
  output_audio_seconds: 'seconds of audio',
  input_audio_tokens: 'input audio tokens',
  input_text_tokens: 'input text tokens',
  output_audio_tokens: 'output audio tokens',
  output_text_tokens: 'output text tokens',
  participant_seconds: 'participant seconds',
}

const MEM_UNVERIFIED =
  'gemini-3.5-flash is no longer on Google’s price page (checked 29 Oct 2026), so this price can’t be verified. The listed Gemini 3.6 Flash costs $0.75 in / $0.075 cached / $3.75 out per 1M tokens (doubling on 1 Jan 2027)'

export const DEFAULT_COST_MODEL: CostModel = {
  v: 2,
  basedOn: CHECKED_ON,
  usdToInr: 95.2,
  pricePerPaidMinuteInr: 100 / 30,
  defaultEngine: 'sarvam',
  checkedOn: CHECKED_ON,
  prices: [
    { id: 'sarvam-stt', label: 'Sarvam speech-to-text (real-time)', provider: 'sarvam', model: '*', unit: 'audio_seconds', price: 0.49, currency: 'INR', per: 60, source: SARVAM, note: '₹0.49 per audio minute, pay-as-you-go (₹0.45 Pro, ₹0.41 Growth, ₹0.38 Business), billed by audio duration. Counted as streamed, silence padding included. Push-to-talk classes stream the whole class (≈ 60 s per class minute); voice mode sends speech only' },
    { id: 'sarvam-tts-v4-flash', label: 'Sarvam Bulbul v4 Flash text-to-speech', provider: 'sarvam', model: 'bulbul:v4-flash', unit: 'characters', price: 2, currency: 'INR', per: 1000, source: SARVAM_V4, note: 'Standard pay-as-you-go price: ₹20 per 10,000 characters (₹2.00 per 1,000). Sarvam’s launch offer (half price through 12 Nov 2026) is deliberately not applied. The voice of the AI tutor since 25 Oct 2026 (Zarina)' },
    { id: 'sarvam-tts-v3', label: 'Sarvam Bulbul v3 text-to-speech', provider: 'sarvam', model: 'bulbul:v3', unit: 'characters', price: 3, currency: 'INR', per: 1000, source: SARVAM, note: '₹3.00 per 1,000 characters, pay-as-you-go' },
    { id: 'sarvam-tts-v2', label: 'Sarvam Bulbul v2 text-to-speech', provider: 'sarvam', model: 'bulbul:v2', unit: 'characters', price: 15, currency: 'INR', per: 10_000, source: SARVAM, note: 'No longer on Sarvam’s price page; last known price' },
    { id: 'llm-in', label: 'Gemini 3.1 Flash-Lite input', provider: 'google', model: 'gemini-3.1-flash-lite', unit: 'input_tokens', price: 0.25, currency: 'USD', per: 1_000_000, source: GEMINI, note: 'Text input, Standard tier. Also prices the memory layer’s running notes (same model)' },
    { id: 'llm-cached', label: 'Gemini 3.1 Flash-Lite cached input', provider: 'google', model: 'gemini-3.1-flash-lite', unit: 'cached_input_tokens', price: 0.025, currency: 'USD', per: 1_000_000, source: GEMINI },
    { id: 'llm-out', label: 'Gemini 3.1 Flash-Lite output', provider: 'google', model: 'gemini-3.1-flash-lite', unit: 'output_tokens', price: 1.5, currency: 'USD', per: 1_000_000, source: GEMINI, note: 'Output including thinking tokens' },
    { id: 'gtts-text', label: 'Gemini Flash-Lite TTS text in', provider: 'google', model: 'gemini-3.8-flash-lite-tts', unit: 'characters', price: 0.125, currency: 'USD', per: 1_000_000, source: GEMINI, note: '$0.50 per 1M text tokens, at ~4 characters per token' },
    { id: 'gtts-text-2027', label: 'Gemini Flash-Lite TTS text in (from 2027)', provider: 'google', model: 'gemini-3.8-flash-lite-tts', unit: 'characters', price: 0.25, currency: 'USD', per: 1_000_000, from: '2027-01-01', source: GEMINI, note: '$1.00 per 1M text tokens from 1 Jan 2027' },
    { id: 'gtts-audio', label: 'Gemini Flash-Lite TTS audio out', provider: 'google', model: 'gemini-3.8-flash-lite-tts', unit: 'output_audio_seconds', price: 0.15, currency: 'USD', per: 1000, source: GEMINI, note: '$6 per 1M audio tokens; Google’s own equivalent: $0.0015 per 10 s of audio' },
    { id: 'gtts-audio-2027', label: 'Gemini Flash-Lite TTS audio out (from 2027)', provider: 'google', model: 'gemini-3.8-flash-lite-tts', unit: 'output_audio_seconds', price: 0.3, currency: 'USD', per: 1000, from: '2027-01-01', source: GEMINI, note: '$12 per 1M audio tokens ($0.003 per 10 s) from 1 Jan 2027' },
    { id: 'rt-audio-in', label: 'Gemini native audio: audio in', provider: 'google', model: REALTIME_MODEL, unit: 'input_audio_tokens', price: 3, currency: 'USD', per: 1_000_000, source: GEMINI },
    { id: 'rt-text-in', label: 'Gemini native audio: text in', provider: 'google', model: REALTIME_MODEL, unit: 'input_text_tokens', price: 0.5, currency: 'USD', per: 1_000_000, source: GEMINI },
    { id: 'rt-cached', label: 'Gemini native audio: cached input', provider: 'google', model: REALTIME_MODEL, unit: 'cached_input_tokens', price: 0.125, currency: 'USD', per: 1_000_000, source: GEMINI, note: 'Not on Google’s price page for this model; assumed 25% of the text-input price (Gemini’s usual cache discount)' },
    { id: 'rt-audio-out', label: 'Gemini native audio: audio out', provider: 'google', model: REALTIME_MODEL, unit: 'output_audio_tokens', price: 12, currency: 'USD', per: 1_000_000, source: GEMINI },
    { id: 'rt-text-out', label: 'Gemini native audio: text out', provider: 'google', model: REALTIME_MODEL, unit: 'output_text_tokens', price: 2, currency: 'USD', per: 1_000_000, source: GEMINI },
    { id: 'mem-in', label: 'Memory model (Gemini 3.5 Flash) input', provider: 'google', model: 'gemini-3.5-flash', unit: 'input_tokens', price: 1.5, currency: 'USD', per: 1_000_000, source: GEMINI, note: `End-of-class reflection. ${MEM_UNVERIFIED}` },
    { id: 'mem-cached', label: 'Memory model (Gemini 3.5 Flash) cached input', provider: 'google', model: 'gemini-3.5-flash', unit: 'cached_input_tokens', price: 0.15, currency: 'USD', per: 1_000_000, source: GEMINI, note: MEM_UNVERIFIED },
    { id: 'mem-out', label: 'Memory model (Gemini 3.5 Flash) output', provider: 'google', model: 'gemini-3.5-flash', unit: 'output_tokens', price: 9, currency: 'USD', per: 1_000_000, source: GEMINI, note: MEM_UNVERIFIED },
    { id: 'livekit', label: 'LiveKit WebRTC minutes', provider: 'livekit', model: '*', unit: 'participant_seconds', price: 0.0005, currency: 'USD', per: 60, source: LIVEKIT, note: 'Ship plan overage ($0.0004 on Scale); set 0 while inside the plan’s included minutes. Agent session minutes ($0.01) apply only to agents hosted on LiveKit Cloud; ours runs on our own server' },
  ],
  assumptions: {
    sarvam: {
      label: 'Sarvam (Indian languages)',
      usage: [
        { priceId: 'sarvam-stt', perMinute: 60 },
        { priceId: 'sarvam-tts-v4-flash', perMinute: 450 },
        { priceId: 'llm-in', perMinute: 8_000 },
        { priceId: 'llm-cached', perMinute: 12_000 },
        { priceId: 'llm-out', perMinute: 300 },
        { priceId: 'mem-in', perMinute: 900 },
        { priceId: 'mem-out', perMinute: 80 },
        { priceId: 'livekit', perMinute: 120 },
      ],
    },
    global: {
      label: 'Global (foreign languages, Gemini TTS)',
      usage: [
        { priceId: 'sarvam-stt', perMinute: 60 },
        { priceId: 'llm-in', perMinute: 8_000 },
        { priceId: 'llm-cached', perMinute: 12_000 },
        { priceId: 'llm-out', perMinute: 300 },
        { priceId: 'gtts-text', perMinute: 450 },
        { priceId: 'gtts-audio', perMinute: 30 },
        { priceId: 'mem-in', perMinute: 900 },
        { priceId: 'mem-out', perMinute: 80 },
        { priceId: 'livekit', perMinute: 120 },
      ],
    },
    gemini: {
      label: 'Gemini native audio',
      usage: [
        { priceId: 'rt-audio-in', perMinute: 1_920 },
        { priceId: 'rt-text-in', perMinute: 15_000 },
        { priceId: 'rt-audio-out', perMinute: 960 },
        { priceId: 'mem-in', perMinute: 900 },
        { priceId: 'mem-out', perMinute: 80 },
        { priceId: 'livekit', perMinute: 120 },
      ],
    },
  },
  fixedMonthly: [
    { label: 'Agent servers (VPS)', amountInr: 0 },
    { label: 'Monitoring (Grafana, Langfuse)', amountInr: 0 },
  ],
}

/** ₹ per one unit of a price line. */
export function unitPriceInr(line: PriceLine, usdToInr: number) {
  return (line.price / line.per) * (line.currency === 'USD' ? usdToInr : 1)
}

/** Today in IST as YYYY-MM-DD: the day a price "from" date is compared with. */
export const istToday = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10)

/** Of several dated lines for one key, the one in force on `day` (the earliest if none has started yet). */
function inForce(lines: PriceLine[], day: string) {
  const sorted = [...lines].sort((a, b) => (a.from ?? '').localeCompare(b.from ?? ''))
  const started = sorted.filter((l) => !l.from || l.from <= day)
  return started[started.length - 1] ?? sorted[0] ?? null
}

/**
 * The price line for a usage row on `day` (IST, YYYY-MM-DD): an exact model match wins
 * over the provider's `*`, and among dated lines the one in force that day.
 */
export function priceFor(model: CostModel, provider: string, modelId: string, unit: string, day = istToday()) {
  const candidates = model.prices.filter((p) => p.provider === provider && p.unit === unit)
  const exact = candidates.filter((p) => p.model === modelId)
  return inForce(exact.length ? exact : candidates.filter((p) => p.model === '*'), day)
}

/** The line in force on `day` for the price an estimate names (estimates name the first line of a key). */
export function lineFor(model: CostModel, priceId: string, day = istToday()) {
  const base = model.prices.find((p) => p.id === priceId)
  return base ? priceFor(model, base.provider, base.model, base.unit, day) : null
}

/** The first line of a line's key: the id estimates and calibration refer to. */
export function baseIdOf(model: CostModel, line: PriceLine) {
  const same = model.prices.filter((p) => p.provider === line.provider && p.model === line.model && p.unit === line.unit)
  return inForce(same, '0000-00-00')?.id ?? line.id
}

/** Estimated ₹ per class minute per engine on `day`, from the assumptions. */
export function perMinuteInr(model: CostModel, day = istToday()) {
  const out = {} as Record<Engine, { total: number; parts: { priceId: string; lineId: string; label: string; inr: number }[] }>
  for (const engine of ENGINES) {
    const parts = model.assumptions[engine].usage.map((u) => {
      const line = lineFor(model, u.priceId, day)
      return {
        priceId: u.priceId,
        lineId: line?.id ?? u.priceId,
        label: line?.label ?? u.priceId,
        inr: line ? unitPriceInr(line, model.usdToInr) * u.perMinute : 0,
      }
    })
    out[engine] = { total: parts.reduce((s, p) => s + p.inr, 0), parts }
  }
  return out
}

const ID = /^[a-z0-9][a-z0-9_.:-]{0,63}$/
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
function num(value: unknown, name: string, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new ApiException(422, `${name} must be a number from 0 to ${max}`)
  }
}

/** Shape and range checks: a typo can't produce a negative or absurd cost. */
export function validateCostModel(raw: unknown): CostModel {
  const m = raw as CostModel
  if (!m || typeof m !== 'object' || m.v !== 2) throw new ApiException(422, 'Cost model (v2) missing')
  num(m.usdToInr, 'usdToInr', 1000)
  num(m.pricePerPaidMinuteInr, 'pricePerPaidMinuteInr', 1000)
  if (!ENGINES.includes(m.defaultEngine)) throw new ApiException(422, 'defaultEngine is invalid')
  if (!Array.isArray(m.prices) || m.prices.length > 100) throw new ApiException(422, 'prices must be a list (up to 100)')
  const ids = new Set<string>()
  const keys = new Set<string>()
  for (const p of m.prices) {
    if (!p || typeof p.id !== 'string' || !ID.test(p.id)) throw new ApiException(422, 'Every price needs an id (a-z, 0-9, - _ . :)')
    if (ids.has(p.id)) throw new ApiException(422, `Duplicate price id ${p.id}`)
    ids.add(p.id)
    if (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 120) throw new ApiException(422, `${p.id}: label is required`)
    for (const field of ['provider', 'unit'] as const) {
      if (typeof p[field] !== 'string' || !ID.test(p[field])) throw new ApiException(422, `${p.id}: ${field} is invalid`)
    }
    if (typeof p.model !== 'string' || (p.model !== '*' && p.model !== '' && !ID.test(p.model))) throw new ApiException(422, `${p.id}: model is invalid`)
    if (p.from !== undefined && (typeof p.from !== 'string' || !DAY.test(p.from))) throw new ApiException(422, `${p.label}: “from” must be a date (YYYY-MM-DD)`)
    const key = `${p.provider}|${p.model}|${p.unit}|${p.from ?? ''}`
    if (keys.has(key)) {
      throw new ApiException(422, `Two prices for ${p.provider} ${p.model} ${p.unit}${p.from ? ` from ${p.from}` : ''}: give the later one a different “from” date`)
    }
    keys.add(key)
    if (!['INR', 'USD'].includes(p.currency)) throw new ApiException(422, `${p.label}: currency must be INR or USD`)
    num(p.price, `${p.label} price`, 1_000_000)
    num(p.per, `${p.label} per`, 1_000_000_000)
    if (p.per === 0) throw new ApiException(422, `${p.label}: “per” can’t be 0`)
  }
  for (const engine of ENGINES) {
    const a = m.assumptions?.[engine]
    if (!a || !Array.isArray(a.usage) || a.usage.length > 30) throw new ApiException(422, `assumptions.${engine} is invalid`)
    for (const u of a.usage) {
      if (!ids.has(u.priceId)) throw new ApiException(422, `assumptions.${engine}: unknown price ${u.priceId}`)
      num(u.perMinute, `${engine} ${u.priceId} per minute`, 10_000_000)
    }
  }
  if (!Array.isArray(m.fixedMonthly) || m.fixedMonthly.length > 20) throw new ApiException(422, 'fixedMonthly must be a list')
  for (const f of m.fixedMonthly) num(f.amountInr, `${f.label} amount`, 100_000_000)
  if (m.basedOn !== undefined && (typeof m.basedOn !== 'string' || !DAY.test(m.basedOn))) throw new ApiException(422, 'basedOn must be a date')
  return m
}

const lineKey = (p: PriceLine) => `${p.provider}|${p.model}|${p.unit}|${p.from ?? ''}`

/**
 * A saved model plus every default price line it doesn't have yet (by id and by key), so
 * a model the tutor starts using (a new voice, a new LLM) is priced instead of counting
 * as ₹0. Lines the saved model already has keep Finance's values.
 */
export function withNewDefaults(saved: CostModel, defaults = DEFAULT_COST_MODEL): CostModel {
  const ids = new Set(saved.prices.map((p) => p.id))
  const keys = new Set(saved.prices.map(lineKey))
  const added = defaults.prices.filter((p) => !ids.has(p.id) && !keys.has(lineKey(p)))
  return added.length ? { ...saved, prices: [...saved.prices, ...structuredClone(added)] } : saved
}

/**
 * The saved model with the latest official prices: default lines take the defaults'
 * values and the USD rate is refreshed. Finance's own lines, estimates, fixed costs and
 * learner price stay.
 */
export function withLatestPrices(saved: CostModel, defaults = DEFAULT_COST_MODEL): CostModel {
  const byId = new Map(defaults.prices.map((p) => [p.id, p]))
  const prices = saved.prices.map((p) => (byId.has(p.id) ? structuredClone(byId.get(p.id)!) : p))
  return withNewDefaults({ ...saved, prices, usdToInr: defaults.usdToInr, basedOn: defaults.basedOn }, defaults)
}

/** Whether official prices were re-checked after this model was saved. */
export function modelStatus(model: CostModel, defaults = DEFAULT_COST_MODEL) {
  const basedOn = model.basedOn ?? null
  return { basedOn, latestCheckedOn: defaults.checkedOn, outdated: !basedOn || basedOn < (defaults.basedOn ?? defaults.checkedOn) }
}

const KEY = 'cost_model'

class CostModelStore {
  async get(): Promise<CostModel> {
    const row = await db.from('console_settings').where('key', KEY).first()
    if (!row) return DEFAULT_COST_MODEL
    const value = (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) as CostModel
    // A model saved in an older shape falls back to the defaults (shown with a notice).
    return value?.v === 2 ? withNewDefaults(value) : DEFAULT_COST_MODEL
  }

  async save(model: CostModel, userId: number, trx: TransactionClientContract) {
    await trx
      .insertQuery()
      .table('console_settings')
      .insert({ key: KEY, value: JSON.stringify(model), updated_by: userId, updated_at: new Date() })
      .knexQuery.onConflict('key')
      .merge()
  }
}

export const costModelStore = new CostModelStore()

/** Languages Sarvam's Bulbul/Saaras serve (agent/languages.js). */
const SARVAM_LANGS = new Set(['en', 'hi', 'bn', 'ta', 'te', 'kn', 'ml', 'mr', 'gu', 'pa', 'od', 'or'])

/**
 * The engine a class without recorded usage most likely ran on, from its taught language
 * (chooseEngine() also needs the explanation language, which older classes don't store).
 */
export function estimateEngine(language: string | null | undefined, fallback: Engine): Engine {
  if (!language) return fallback
  const base = language.toLowerCase().split('-')[0]
  return SARVAM_LANGS.has(base) ? 'sarvam' : 'global'
}
