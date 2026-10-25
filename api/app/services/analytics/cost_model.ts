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
  source?: string
  note?: string
}

export interface CostModel {
  v: 2
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

const SARVAM = 'https://sarvam.ai/api-pricing'
const LIVEKIT = 'https://livekit.io/pricing'
const GEMINI = 'https://ai.google.dev/gemini-api/docs/pricing'
const CONFIRM = 'Third-party figure; confirm on the Gemini pricing page'
const REALTIME_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025'

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

export const DEFAULT_COST_MODEL: CostModel = {
  v: 2,
  usdToInr: 88,
  pricePerPaidMinuteInr: 100 / 30,
  defaultEngine: 'sarvam',
  checkedOn: '2026-10-25',
  prices: [
    { id: 'sarvam-stt', label: 'Sarvam speech-to-text', provider: 'sarvam', model: '*', unit: 'audio_seconds', price: 30, currency: 'INR', per: 3600, source: SARVAM, note: '₹30 per audio hour, billed per second. Measured: the agent streams the whole class to Sarvam (SDK 1.4.7 keeps the room audio feed on), so budget ≈ 60 s per class minute' },
    { id: 'sarvam-tts-v4-flash', label: 'Sarvam Bulbul v4 Flash text-to-speech', provider: 'sarvam', model: 'bulbul:v4-flash', unit: 'characters', price: 20, currency: 'INR', per: 10_000, source: SARVAM, note: '₹20 per 10K characters (₹10 promotional until 12 Nov 2026). The tutor's voice since 25 Oct 2026 (Zarina)' },
    { id: 'sarvam-tts-v3', label: 'Sarvam Bulbul v3 text-to-speech', provider: 'sarvam', model: 'bulbul:v3', unit: 'characters', price: 30, currency: 'INR', per: 10_000, source: SARVAM, note: '₹30 per 10K characters (beta pricing)' },
    { id: 'sarvam-tts-v2', label: 'Sarvam Bulbul v2 text-to-speech', provider: 'sarvam', model: 'bulbul:v2', unit: 'characters', price: 15, currency: 'INR', per: 10_000, source: SARVAM },
    { id: 'llm-in', label: 'Gemini 3.1 Flash-Lite input', provider: 'google', model: 'gemini-3.1-flash-lite', unit: 'input_tokens', price: 0.25, currency: 'USD', per: 1_000_000, source: GEMINI, note: CONFIRM },
    { id: 'llm-cached', label: 'Gemini 3.1 Flash-Lite cached input', provider: 'google', model: 'gemini-3.1-flash-lite', unit: 'cached_input_tokens', price: 0.025, currency: 'USD', per: 1_000_000, source: GEMINI, note: CONFIRM },
    { id: 'llm-out', label: 'Gemini 3.1 Flash-Lite output', provider: 'google', model: 'gemini-3.1-flash-lite', unit: 'output_tokens', price: 1.5, currency: 'USD', per: 1_000_000, source: GEMINI, note: CONFIRM },
    { id: 'gtts-text', label: 'Gemini Flash-Lite TTS text in', provider: 'google', model: 'gemini-3.8-flash-lite-tts', unit: 'characters', price: 0.125, currency: 'USD', per: 1_000_000, source: GEMINI, note: `${CONFIRM}. $0.50 per 1M text tokens at ~4 characters per token` },
    { id: 'gtts-audio', label: 'Gemini Flash-Lite TTS audio out', provider: 'google', model: 'gemini-3.8-flash-lite-tts', unit: 'output_audio_seconds', price: 0.192, currency: 'USD', per: 1000, source: GEMINI, note: '$6 per 1M audio tokens × 32 tokens/s (Google, checked 24 Oct 2026); $12 from 1 Jan 2027' },
    { id: 'rt-audio-in', label: 'Gemini native audio: audio in', provider: 'google', model: REALTIME_MODEL, unit: 'input_audio_tokens', price: 3, currency: 'USD', per: 1_000_000, source: GEMINI, note: CONFIRM },
    { id: 'rt-text-in', label: 'Gemini native audio: text in', provider: 'google', model: REALTIME_MODEL, unit: 'input_text_tokens', price: 0.5, currency: 'USD', per: 1_000_000, source: GEMINI, note: CONFIRM },
    { id: 'rt-cached', label: 'Gemini native audio: cached input', provider: 'google', model: REALTIME_MODEL, unit: 'cached_input_tokens', price: 0.125, currency: 'USD', per: 1_000_000, source: GEMINI, note: `${CONFIRM}. Assumed 25% of the text-input price (Gemini's usual cache discount)` },
    { id: 'rt-audio-out', label: 'Gemini native audio: audio out', provider: 'google', model: REALTIME_MODEL, unit: 'output_audio_tokens', price: 12, currency: 'USD', per: 1_000_000, source: GEMINI, note: CONFIRM },
    { id: 'rt-text-out', label: 'Gemini native audio: text out', provider: 'google', model: REALTIME_MODEL, unit: 'output_text_tokens', price: 2, currency: 'USD', per: 1_000_000, source: GEMINI, note: CONFIRM },
    { id: 'mem-in', label: 'Memory model (Gemini 3.5 Flash) input', provider: 'google', model: 'gemini-3.5-flash', unit: 'input_tokens', price: 1.5, currency: 'USD', per: 1_000_000, source: GEMINI, note: `${CONFIRM}. Running notes + end-of-class reflection` },
    { id: 'mem-cached', label: 'Memory model (Gemini 3.5 Flash) cached input', provider: 'google', model: 'gemini-3.5-flash', unit: 'cached_input_tokens', price: 0.15, currency: 'USD', per: 1_000_000, source: GEMINI, note: CONFIRM },
    { id: 'mem-out', label: 'Memory model (Gemini 3.5 Flash) output', provider: 'google', model: 'gemini-3.5-flash', unit: 'output_tokens', price: 9, currency: 'USD', per: 1_000_000, source: GEMINI, note: CONFIRM },
    { id: 'livekit', label: 'LiveKit participant minutes', provider: 'livekit', model: '*', unit: 'participant_seconds', price: 0.0005, currency: 'USD', per: 60, source: LIVEKIT, note: 'Ship plan overage; set 0 if self-hosted or inside the included minutes' },
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

/** The price line for a usage row: an exact model match wins over the provider's `*`. */
export function priceFor(model: CostModel, provider: string, modelId: string, unit: string) {
  const candidates = model.prices.filter((p) => p.provider === provider && p.unit === unit)
  return candidates.find((p) => p.model === modelId) ?? candidates.find((p) => p.model === '*') ?? null
}

/** Estimated ₹ per class minute per engine, from the assumptions. */
export function perMinuteInr(model: CostModel) {
  const out = {} as Record<Engine, { total: number; parts: { priceId: string; label: string; inr: number }[] }>
  for (const engine of ENGINES) {
    const parts = model.assumptions[engine].usage.map((u) => {
      const line = model.prices.find((p) => p.id === u.priceId)
      return {
        priceId: u.priceId,
        label: line?.label ?? u.priceId,
        inr: line ? unitPriceInr(line, model.usdToInr) * u.perMinute : 0,
      }
    })
    out[engine] = { total: parts.reduce((s, p) => s + p.inr, 0), parts }
  }
  return out
}

const ID = /^[a-z0-9][a-z0-9_.:-]{0,63}$/
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
    const key = `${p.provider}|${p.model}|${p.unit}`
    if (keys.has(key)) throw new ApiException(422, `Two prices for ${p.provider} ${p.model} ${p.unit}`)
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
  return m
}

const KEY = 'cost_model'

class CostModelStore {
  async get(): Promise<CostModel> {
    const row = await db.from('console_settings').where('key', KEY).first()
    if (!row) return DEFAULT_COST_MODEL
    const value = (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) as CostModel
    // A model saved in an older shape falls back to the defaults (shown with a notice).
    return value?.v === 2 ? value : DEFAULT_COST_MODEL
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
