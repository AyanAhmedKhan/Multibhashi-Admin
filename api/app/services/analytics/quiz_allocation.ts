import type { AnswerType, MarkingPath } from '#services/analytics/quiz_analytics'

/**
 * Cost per quiz answer (docs/QUIZ_OBSERVABILITY.md §4). The providers bill per day, and the
 * backend doesn't record individual calls, so:
 * - each day's ACTUAL provider cost is spread over that day's answers in proportion to an
 *   estimated weight (speech: billed seconds; marking: estimated tokens × list price);
 * - a day without provider data gets the ESTIMATE (weights × rate card), labelled as such.
 * A day's actual total is preserved exactly; one answer's share is an estimate.
 * Pure functions: no database, unit-tested.
 */

export interface AnswerFacts {
  key: string
  type: AnswerType
  /** IST day, YYYY-MM-DD */
  day: string
  path: MarkingPath
  words: number
  sentences: number
  /** Evidence marking attempts (each = grammar, independent review, content). */
  attempts: number
  /** Seconds recorded in the app (quiz_record_stopped), when the event exists. */
  recordedSeconds: number | null
}

/** Speech-to-text: Google bills each request rounded up to the second (price page, 29 Oct 2026). */
export const SPEECH = { wordsPerSecond: 2.3, minSeconds: 1, maxSeconds: 58 }

/**
 * Tokens per marking call. legacy and counted from the spec; evidence measured offline from the
 * current code on 2026-10-29 (grammar-call input by answer length; ~75 % of it is the JSON
 * response schema, which grows with the answer). Marked "assumption" where the spec gives
 * no figure.
 */
export const MARKING = {
  legacy: { calls: 1, input: 600, output: 150 },
  /** ≈ 1,650 tokens per answer; split 80/20 like legacy (assumption). */
  counted: { calls: 1, input: 1320, output: 330 },
  evidence: {
    grammarInput: [
      [40, 3100],
      [100, 5760],
      [180, 8840],
    ] as [number, number][],
    /** "≈ 1,300–2,800" in the spec, mapped onto 40–180 words (assumption). */
    contentInput: [
      [40, 1300],
      [180, 2800],
    ] as [number, number][],
    /** 200–220 output tokens per answer sentence per grammar call. */
    grammarOutputPerSentence: 210,
    /** Content call output: per-unit relevance + per-point coverage (assumption). */
    contentOutput: { base: 150, perSentence: 30 },
  },
}

/** Piecewise-linear through the points, extended along the end segments. */
export function interpolate(points: [number, number][], x: number) {
  if (points.length === 1) return points[0][1]
  let i = 0
  while (i < points.length - 2 && x > points[i + 1][0]) i++
  const [x0, y0] = points[i]
  const [x1, y1] = points[i + 1]
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
}

/** Seconds Google bills for a Speaking answer (0 for Writing). */
export function billedSpeechSeconds(a: Pick<AnswerFacts, 'type' | 'words' | 'recordedSeconds'>) {
  if (a.type !== 'SQ') return { seconds: 0, from: null }
  const recorded = a.recordedSeconds !== null && a.recordedSeconds > 0
  const raw = recorded ? a.recordedSeconds! : a.words / SPEECH.wordsPerSecond
  const clamped = Math.min(SPEECH.maxSeconds, Math.max(SPEECH.minSeconds, raw))
  return { seconds: Math.ceil(clamped - 1e-9), from: recorded ? ('recording' as const) : ('words' as const) }
}

/** Estimated marking calls and tokens for one answer. An empty answer isn't marked. */
export function markingTokens(a: Pick<AnswerFacts, 'path' | 'words' | 'sentences' | 'attempts'>) {
  if (a.words <= 0) return { calls: 0, input: 0, output: 0 }
  if (a.path === 'legacy') return { ...MARKING.legacy }
  if (a.path === 'counted') return { ...MARKING.counted }
  const e = MARKING.evidence
  const sentences = Math.max(1, a.sentences)
  const attempts = Math.max(1, a.attempts)
  const grammarIn = Math.max(1300, interpolate(e.grammarInput, a.words))
  const contentIn = Math.max(1300, interpolate(e.contentInput, a.words))
  const perAttemptIn = 2 * grammarIn + contentIn
  const perAttemptOut = 2 * e.grammarOutputPerSentence * sentences + e.contentOutput.base + e.contentOutput.perSentence * sentences
  return { calls: 3 * attempts, input: Math.round(perAttemptIn * attempts), output: Math.round(perAttemptOut * attempts) }
}

/** ₹ per unit on a day, from the rate card. */
export interface Rates {
  speechPerSecondInr: number
  inputPerTokenInr: number
  outputPerTokenInr: number
}

export function estimate(a: AnswerFacts, rates: Rates) {
  const speech = billedSpeechSeconds(a)
  const tokens = markingTokens(a)
  return {
    speechSeconds: speech.seconds,
    speechFrom: speech.from,
    tokens,
    speechInr: speech.seconds * rates.speechPerSecondInr,
    markingInr: tokens.input * rates.inputPerTokenInr + tokens.output * rates.outputPerTokenInr,
  }
}

/** actual = the provider's billed cost; usage = the provider's token counts × list price; estimated = rate card × weights. */
export type Basis = 'actual' | 'usage' | 'estimated'

/** What the providers reported for one day (absent/null = no provider data for that pool). */
export interface DayActuals {
  speechInr?: number | null
  markingInr?: number | null
  markingBasis?: 'actual' | 'usage'
}

export interface DayPool {
  inr: number
  basis: Basis
  answers: number
  /** Provider cost on a day with nothing to spread it over (e.g. tests, other callers). */
  unallocatedInr: number
  /** What the rate card says the day should have cost (for comparison). */
  estimatedInr: number
}

export interface AllocatedAnswer {
  key: string
  speechInr: number
  markingInr: number
  speechBasis: Basis | null
  markingBasis: Basis | null
  estimate: ReturnType<typeof estimate>
}

function spread(actual: number, weights: number[], fallback: number[]) {
  const total = weights.reduce((s, w) => s + w, 0)
  if (total > 0) return weights.map((w) => (actual * w) / total)
  const alt = fallback.reduce((s, w) => s + w, 0)
  if (alt > 0) return fallback.map((w) => (actual * w) / alt)
  return weights.map(() => 0)
}

/**
 * Per-answer cost: each pool (speech, marking) of each day is either the provider's figure
 * spread by weight, or the estimate when the provider has no data for that day.
 */
export function allocate(answers: AnswerFacts[], actuals: Map<string, DayActuals>, ratesOn: (day: string) => Rates) {
  const byDay = new Map<string, AnswerFacts[]>()
  for (const a of answers) {
    if (!byDay.has(a.day)) byDay.set(a.day, [])
    byDay.get(a.day)!.push(a)
  }
  const out: AllocatedAnswer[] = []
  const days = new Map<string, { speech: DayPool; marking: DayPool }>()
  for (const day of new Set([...byDay.keys(), ...actuals.keys()])) {
    const list = byDay.get(day) ?? []
    const rates = ratesOn(day)
    const est = list.map((a) => estimate(a, rates))
    const act = actuals.get(day) ?? {}
    const speechList = list.map((a, i) => ({ a, e: est[i] })).filter(({ a }) => a.type === 'SQ')
    const markedList = list.map((a, i) => ({ a, e: est[i] })).filter(({ e }) => e.tokens.calls > 0)
    const speechEstimated = speechList.reduce((s, x) => s + x.e.speechInr, 0)
    const markingEstimated = markedList.reduce((s, x) => s + x.e.markingInr, 0)

    const speechActual = typeof act.speechInr === 'number' ? act.speechInr : null
    const markingActual = typeof act.markingInr === 'number' ? act.markingInr : null
    const speechShares = speechActual === null ? null : spread(speechActual, speechList.map((x) => x.e.speechSeconds), speechList.map(() => 1))
    const markingShares =
      markingActual === null
        ? null
        : spread(markingActual, markedList.map((x) => x.e.markingInr), markedList.map((x) => x.e.tokens.input + x.e.tokens.output))
    const speechBy = new Map(speechList.map((x, i) => [x.a.key, speechShares ? speechShares[i] : x.e.speechInr]))
    const markingBy = new Map(markedList.map((x, i) => [x.a.key, markingShares ? markingShares[i] : x.e.markingInr]))
    const speechBasis: Basis = speechActual === null ? 'estimated' : 'actual'
    const markingBasis: Basis = markingActual === null ? 'estimated' : (act.markingBasis ?? 'actual')

    list.forEach((a, i) => {
      out.push({
        key: a.key,
        speechInr: speechBy.get(a.key) ?? 0,
        markingInr: markingBy.get(a.key) ?? 0,
        speechBasis: a.type === 'SQ' ? speechBasis : null,
        markingBasis: est[i].tokens.calls > 0 ? markingBasis : null,
        estimate: est[i],
      })
    })
    const allocated = (shares: number[] | null) => (shares ?? []).reduce((s, v) => s + v, 0)
    days.set(day, {
      speech: {
        inr: speechActual ?? speechEstimated,
        basis: speechBasis,
        answers: speechList.length,
        unallocatedInr: speechActual === null ? 0 : speechActual - allocated(speechShares),
        estimatedInr: speechEstimated,
      },
      marking: {
        inr: markingActual ?? markingEstimated,
        basis: markingBasis,
        answers: markedList.length,
        unallocatedInr: markingActual === null ? 0 : markingActual - allocated(markingShares),
        estimatedInr: markingEstimated,
      },
    })
  }
  return { answers: out, days }
}
