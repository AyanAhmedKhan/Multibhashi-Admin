import type { AnswerRow, Context, QuizEvent } from '#services/analytics/quiz_analytics'
import type { Basis } from '#services/analytics/quiz_allocation'

/**
 * Daily quiz metrics for before/after comparisons (docs/QUIZ_OBSERVABILITY.md §7).
 *
 * Every metric is stored per IST day and segment as (num, den), plus a histogram for a
 * distribution, so a window of any length is SUM(num) / SUM(den) — the same definition on
 * both sides of a change. The definitions are versioned: a change to how a metric is
 * computed is a new DEFINITION_VERSION, never a silent rewrite of the stored "before".
 *
 * Pure functions: no database, unit-tested.
 */

export const DEFINITION_VERSION = 1

/**
 * count: num (den unused) · rate: num / den, a share of something · distribution: num = sum,
 * den = count (so num / den is the mean), hist = per-bucket counts · cost: num / den in ₹ (or
 * a day's ₹ when den is 1 per day).
 */
export type MetricKind = 'count' | 'rate' | 'distribution' | 'cost'
export type MetricSource = 'answers' | 'attempts' | 'events' | 'bills'
/** Which way is better. "context": depends on the change (a longer answer costs more). */
export type Better = 'down' | 'up' | 'flat' | 'context'

export interface MetricDef {
  key: string
  label: string
  kind: MetricKind
  source: MetricSource
  unit: string
  better: Better
  /** Brief phases this metric is evidence for ('0'–'6'); empty = a volume or guardrail figure. */
  phases: string[]
  /** How it is computed, in one sentence (shown in the console). */
  how: string
  /** distribution: bucket i holds values in [edges[i], edges[i + 1]); the last is open-ended. */
  edges?: number[]
}

const WORDS = [0, 1, 10, 25, 50, 100, 150, 200, 300]
const SECONDS = [0, 10, 20, 30, 45, 60, 90, 120, 180, 300, 600]
const SCORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const WAIT_MS = [0, 2000, 5000, 10_000, 20_000, 40_000, 60_000, 90_000]
const RECORDED = [0, 3, 5, 10, 20, 30, 45, 58]

const m = (
  key: string,
  label: string,
  kind: MetricKind,
  source: MetricSource,
  unit: string,
  better: Better,
  phases: string[],
  how: string,
  edges?: number[]
): MetricDef => ({ key, label, kind, source, unit, better, phases, how, ...(edges ? { edges } : {}) })

export const METRICS: MetricDef[] = [
  // ---- answers (the answer tables; history back to the backfill start)
  m('sq_answers', 'Speaking answers', 'count', 'answers', 'answers', 'flat', [], 'Speaking (SQ) answers saved that day.'),
  m('wq_answers', 'Writing answers', 'count', 'answers', 'answers', 'flat', [], 'Writing (WQ) answers saved that day.'),
  m('sq_late_share', 'Speaking answers past the timer', 'rate', 'answers', '%', 'down', ['1', '2'], 'SQ answers with finished_on_time = 0, of those with the flag set.'),
  m('wq_late_share', 'Writing answers past the timer', 'rate', 'answers', '%', 'down', ['2'], 'WQ answers with finished_on_time = 0, of those with the flag set.'),
  m('sq_no_speech_share', 'Speaking answers with no speech', 'rate', 'answers', '%', 'down', ['1', '4'], 'SQ answers whose saved transcript has no words.'),
  m('wq_empty_share', 'Empty Writing answers', 'rate', 'answers', '%', 'down', ['1', '2'], 'WQ answers saved with no words.'),
  m('wq_under_10_words_share', 'Writing answers under 10 words', 'rate', 'answers', '%', 'down', ['2', '3'], 'WQ answers of 1–9 words, of the non-empty ones.'),
  m('wq_short_high_relevance_share', 'Short Writing answers marked as relevant', 'rate', 'answers', '%', 'down', ['3'], 'WQ answers of 1–9 words with relevance 8 or more, of all 1–9 word answers.'),
  m('sq_marking_failed_share', 'Speaking marking failures', 'rate', 'answers', '%', 'down', ['0'], 'SQ answers whose marking failed (status failed, or no score for a non-empty answer).'),
  m('wq_marking_failed_share', 'Writing marking failures', 'rate', 'answers', '%', 'down', ['0'], 'WQ answers whose marking failed.'),
  m('sq_correct_share', 'Speaking pass rate', 'rate', 'answers', '%', 'flat', [], 'SQ answers marked correct, of those with is_correct set. A guardrail: fixes must not move it.'),
  m('wq_correct_share', 'Writing pass rate', 'rate', 'answers', '%', 'flat', [], 'WQ answers marked correct. A guardrail.'),
  m('evidence_path_share', 'Answers on evidence marking', 'rate', 'answers', '%', 'context', [], 'Answers marked by the 3-call evidence path; it changes cost per answer.'),
  m('evidence_retried_share', 'Evidence marking retried', 'rate', 'answers', '%', 'down', ['0'], 'Evidence-marked answers that needed more than one attempt.'),
  m('sq_words', 'Words per Speaking answer', 'distribution', 'answers', 'words', 'context', ['2', '3'], 'Words in the saved transcript.', WORDS),
  m('wq_words', 'Words per Writing answer', 'distribution', 'answers', 'words', 'context', ['2', '3'], 'Words in the saved answer.', WORDS),
  m('sq_time_taken', 'Time on a Speaking question', 'distribution', 'answers', 's', 'context', ['2'], 'time_taken in seconds, when recorded.', SECONDS),
  m('wq_time_taken', 'Time on a Writing question', 'distribution', 'answers', 's', 'context', ['2'], 'time_taken in seconds, when recorded.', SECONDS),
  m('sq_relevance', 'Speaking relevance', 'distribution', 'answers', '0–10', 'flat', [], 'Relevance score (guardrail).', SCORE),
  m('sq_grammar', 'Speaking grammar', 'distribution', 'answers', '0–10', 'flat', [], 'Grammar score (guardrail).', SCORE),
  m('sq_pronunciation', 'Speaking pronunciation', 'distribution', 'answers', '0–10', 'flat', ['6'], 'Pronunciation score; phase 6 moves it to the server.', SCORE),
  m('wq_relevance', 'Writing relevance', 'distribution', 'answers', '0–10', 'flat', [], 'Relevance score (guardrail).', SCORE),
  m('wq_grammar', 'Writing grammar', 'distribution', 'answers', '0–10', 'flat', [], 'Grammar score (guardrail).', SCORE),

  // ---- attempts (the parent logs)
  m('attempts_started', 'Quiz attempts', 'count', 'attempts', 'attempts', 'flat', [], 'Attempts with at least one saved answer, by the day they started.'),
  m('attempt_finished_share', 'Attempts finished', 'rate', 'attempts', '%', 'up', ['1'], 'Attempts marked finished, of those with at least one answer.'),
  m('sw_attempt_finished_share', 'Attempts with Speaking/Writing finished', 'rate', 'attempts', '%', 'up', ['1', '2', '4'], 'Attempts with an SQ or WQ answer that were finished.'),
  m('attempt_left_after_timeout_share', 'Attempts left after a timeout', 'rate', 'attempts', '%', 'down', ['1'], 'Unfinished attempts whose last saved answer ran out of time, of all attempts with an answer.'),

  // ---- the app's events (from the telemetry release on)
  m('ev_sq_shown', 'Speaking questions shown', 'count', 'events', 'questions', 'flat', [], 'quiz_question_shown for SQ.'),
  m('ev_wq_shown', 'Writing questions shown', 'count', 'events', 'questions', 'flat', [], 'quiz_question_shown for WQ.'),
  m('ev_record_started', 'Recordings started', 'count', 'events', 'recordings', 'flat', [], 'quiz_record_started (Speaking and pronunciation).'),
  m('ev_record_failed', 'Recording start failures', 'count', 'events', 'failures', 'down', ['4'], 'quiz_record_failed, by error (segment error:…).'),
  m('ev_record_failed_share', 'Recording start failure rate', 'rate', 'events', '%', 'down', ['4'], 'quiz_record_failed of (started + failed).'),
  m('ev_submit_failed', 'Submit failures', 'count', 'events', 'failures', 'down', ['1', '4'], 'quiz_submit_failed for SQ/WQ, by stage (segment stage:…).'),
  m('ev_submit_failed_rate', 'Submit failures per answer', 'rate', 'events', '%', 'down', ['1', '4'], 'quiz_submit_failed of quiz_answer_submitted (SQ/WQ).'),
  m('ev_stt_no_speech_share', 'Speech-to-text heard nothing', 'rate', 'events', '%', 'down', ['4'], 'quiz_stt_result no_speech, of all results.'),
  m('ev_stt_failed_share', 'Speech-to-text failed', 'rate', 'events', '%', 'down', ['0', '4'], 'quiz_stt_result failed, of all results.'),
  m('ev_eval_failed_share', 'Marking failed (app side)', 'rate', 'events', '%', 'down', ['0'], 'quiz_eval_result failed, of all results.'),
  m('ev_feedback_wait_ms', 'Wait from submit to feedback', 'distribution', 'events', 'ms', 'down', ['4'], 'quiz_feedback_shown ms.', WAIT_MS),
  m('ev_timeout_rate', 'Questions that timed out', 'rate', 'events', '%', 'down', ['2'], 'quiz_question_timeout of SQ/WQ questions shown.'),
  m('ev_timeout_stuck_share', 'Stuck after a timeout', 'rate', 'events', '%', 'down', ['1'], 'SQ/WQ timeouts with no feedback for that question within 10 min and no other question shown within 30 min.'),
  m('ev_rerecord_share', 'Questions re-recorded', 'rate', 'events', '%', 'context', ['4', '5'], 'SQ questions (learner, attempt, day) with more than one recording stopped.'),
  m('ev_recorded_seconds', 'Recording length', 'distribution', 'events', 's', 'context', ['2', '3'], 'quiz_record_stopped seconds.', RECORDED),
  m('ev_paste_blocked_rate', 'Paste blocks per Writing question', 'rate', 'events', '%', 'context', ['5'], 'quiz_paste_blocked of WQ questions shown.'),

  // ---- cost (provider bills, allocated per answer; estimates labelled)
  m('cost_speech_inr', 'Speech-to-text spend', 'cost', 'bills', '₹', 'down', ['0'], 'Google speech-to-text attributed to quizzes, per day.'),
  m('cost_marking_inr', 'Marking spend', 'cost', 'bills', '₹', 'down', ['0'], 'OpenAI quiz marking, per day.'),
  m('cost_speech_per_sq_inr', 'Speech-to-text ₹ per Speaking answer', 'cost', 'bills', '₹', 'context', ['0', '2', '3'], "The day's speech spend ÷ SQ answers. Longer answers (phases 2–3) raise it."),
  m('cost_marking_per_answer_inr', 'Marking ₹ per marked answer', 'cost', 'bills', '₹', 'down', ['0'], "The day's marking spend ÷ non-empty answers."),
  m('cost_per_answer_inr', 'AI ₹ per answer', 'cost', 'bills', '₹', 'context', ['0'], 'Speech + marking ÷ SQ/WQ answers.'),
  m('cost_per_finished_sw_attempt_inr', 'AI ₹ per finished attempt', 'cost', 'bills', '₹', 'down', ['0', '1'], 'Speech + marking ÷ finished attempts with SQ/WQ answers.'),
  m('stt_billed_seconds_per_sq', 'Seconds billed per Speaking answer', 'cost', 'bills', 's', 'context', ['0', '2', '3'], "Google's billed seconds ÷ SQ answers (25.6 s in Oct–Nov 2026)."),
  m('openai_requests_per_marked', 'OpenAI requests per marked answer', 'cost', 'bills', 'requests', 'down', ['0'], 'Quiz-key requests ÷ non-empty answers; calls not tied to an answer show up here.'),
  m('openai_tokens_per_marked', 'OpenAI tokens per marked answer', 'cost', 'bills', 'tokens', 'down', ['0'], 'Quiz-key input + output tokens ÷ non-empty answers.'),
]

export const METRIC_BY_KEY = new Map(METRICS.map((d) => [d.key, d]))

/** One stored row before it is written. */
export interface MetricRow {
  day: string
  metric: string
  segment: string
  num: number
  den: number
  hist: number[] | null
  basis: Basis | null
}

export function bucketOf(value: number, edges: number[]) {
  let i = 0
  while (i < edges.length - 1 && value >= edges[i + 1]) i++
  return i
}

/** Rows accumulated by (day, metric, segment). */
class Acc {
  #rows = new Map<string, MetricRow>()

  private row(day: string, metric: string, segment: string) {
    const key = `${day}|${metric}|${segment}`
    let r = this.#rows.get(key)
    if (!r) {
      const def = METRIC_BY_KEY.get(metric)
      if (!def) throw new Error(`unknown metric ${metric}`)
      r = { day, metric, segment, num: 0, den: 0, hist: def.edges ? def.edges.map(() => 0) : null, basis: null }
      this.#rows.set(key, r)
    }
    return r
  }

  /** count: +1 (or n) */
  count(day: string, metric: string, segments: string[], n = 1) {
    for (const s of segments) this.row(day, metric, s).num += n
  }

  /** rate: den +1, num +1 when `hit` */
  rate(day: string, metric: string, segments: string[], hit: boolean) {
    for (const s of segments) {
      const r = this.row(day, metric, s)
      r.den += 1
      if (hit) r.num += 1
    }
  }

  /**
   * The numerator of a rate whose denominator is counted on other events (a submit failure
   * of the answers submitted, a timeout of the questions shown): num +1, den unchanged.
   */
  hit(day: string, metric: string, segments: string[]) {
    for (const s of segments) this.row(day, metric, s).num += 1
  }

  /** distribution: one value */
  value(day: string, metric: string, segments: string[], v: number | null) {
    if (v === null || !Number.isFinite(v) || v < 0) return
    const edges = METRIC_BY_KEY.get(metric)!.edges!
    const b = bucketOf(v, edges)
    for (const s of segments) {
      const r = this.row(day, metric, s)
      r.num += v
      r.den += 1
      r.hist![b] += 1
    }
  }

  /** cost: one day's num / den with its basis */
  set(day: string, metric: string, num: number, den: number, basis: Basis | null) {
    const r = this.row(day, metric, 'all')
    r.num = num
    r.den = den
    r.basis = basis
  }

  rows() {
    return [...this.#rows.values()]
  }
}

/** Segment labels are cut to the column (64) and stripped of separators. */
export const seg = (name: string, value: string | null | undefined) =>
  `${name}:${value === null || value === undefined || value === '' ? 'unknown' : String(value).replace(/[|\s]+/g, '_').slice(0, 56)}`

export interface AttemptDevice {
  device: string | null
  appVersion: string | null
}

/** Segments of an answer or attempt: all, its delivery context, the device and app version when known. */
export function deliverySegments(context: Context, device: AttemptDevice | null | undefined) {
  const out = ['all', seg('context', context), seg('device', device?.device ?? null)]
  if (device?.appVersion) out.push(seg('app', device.appVersion))
  return out
}

export function answerMetrics(answers: AnswerRow[], deviceOf: (a: AnswerRow) => AttemptDevice | null, from: string, to: string) {
  const acc = new Acc()
  for (const a of answers) {
    if (a.day < from || a.day >= to) continue
    const s = deliverySegments(a.context, deviceOf(a))
    const d = a.day
    if (a.type === 'SQ') {
      acc.count(d, 'sq_answers', s)
      if (a.onTime !== null) acc.rate(d, 'sq_late_share', s, a.onTime === false)
      acc.rate(d, 'sq_no_speech_share', s, a.words === 0)
      acc.rate(d, 'sq_marking_failed_share', s, a.failed)
      if (a.isCorrect !== null) acc.rate(d, 'sq_correct_share', s, a.isCorrect)
      acc.value(d, 'sq_words', s, a.words)
      acc.value(d, 'sq_time_taken', s, a.timeTaken !== null && a.timeTaken > 0 ? a.timeTaken : null)
      acc.value(d, 'sq_relevance', s, a.relevance)
      acc.value(d, 'sq_grammar', s, a.grammar)
      acc.value(d, 'sq_pronunciation', s, a.pronunciation)
    } else {
      acc.count(d, 'wq_answers', s)
      if (a.onTime !== null) acc.rate(d, 'wq_late_share', s, a.onTime === false)
      acc.rate(d, 'wq_empty_share', s, a.words === 0)
      if (a.words >= 1) acc.rate(d, 'wq_under_10_words_share', s, a.words < 10)
      if (a.words >= 1 && a.words < 10 && a.relevance !== null) acc.rate(d, 'wq_short_high_relevance_share', s, a.relevance >= 8)
      acc.rate(d, 'wq_marking_failed_share', s, a.failed)
      if (a.isCorrect !== null) acc.rate(d, 'wq_correct_share', s, a.isCorrect)
      acc.value(d, 'wq_words', s, a.words)
      acc.value(d, 'wq_time_taken', s, a.timeTaken !== null && a.timeTaken > 0 ? a.timeTaken : null)
      acc.value(d, 'wq_relevance', s, a.relevance)
      acc.value(d, 'wq_grammar', s, a.grammar)
    }
    acc.rate(d, 'evidence_path_share', s, a.path === 'evidence')
    if (a.path === 'evidence') acc.rate(d, 'evidence_retried_share', s, a.attempts > 1)
  }
  return acc.rows()
}

/** One quiz attempt (a parent log row) with what its saved answers say. */
export interface AttemptRow {
  key: string
  context: Context
  logId: number
  userId: number
  quizId: number
  /** IST day the attempt started */
  day: string
  startMs: number | null
  finished: boolean
  /** Saved answers of any type */
  answered: number
  /** Saved SQ/WQ answers */
  speakingWriting: number
  /** The last saved answer ran out of time (finished_on_time = 0); null when not recorded. */
  lastTimedOut: boolean | null
}

export function attemptMetrics(attempts: AttemptRow[], deviceOf: (a: AttemptRow) => AttemptDevice | null, from: string, to: string) {
  const acc = new Acc()
  for (const a of attempts) {
    if (a.day < from || a.day >= to || a.answered < 1) continue
    const s = deliverySegments(a.context, deviceOf(a))
    acc.count(a.day, 'attempts_started', s)
    acc.rate(a.day, 'attempt_finished_share', s, a.finished)
    if (a.speakingWriting > 0) acc.rate(a.day, 'sw_attempt_finished_share', s, a.finished)
    acc.rate(a.day, 'attempt_left_after_timeout_share', s, !a.finished && a.lastTimedOut === true)
  }
  return acc.rows()
}

/** A quiz event with its session's device and app version and the device the app reported. */
export interface MetricEvent extends QuizEvent {
  /** student_sessions.device: web | ios | android | unknown */
  device: string | null
  appVersion: string | null
  /** metadata.os: ios | android | desktop (from the telemetry release that sends it) */
  os: string | null
  inApp: boolean
}

export const STUCK = { feedbackWithinMs: 10 * 60_000, movedOnWithinMs: 30 * 60_000 }

const SW = new Set(['SQ', 'WQ'])

export function eventSegments(e: MetricEvent) {
  const out = ['all', seg('device', e.device)]
  if (e.os) out.push(seg('os', e.os))
  if (e.inApp) out.push('in_app:yes')
  if (e.appVersion) out.push(seg('app', e.appVersion))
  return out
}

/**
 * `events` may run past `to` (lookahead for "stuck after a timeout"); only events on days in
 * [from, to) are counted. `dayOf` maps epoch ms to the IST day label.
 */
export function eventMetrics(events: MetricEvent[], dayOf: (ms: number) => string, from: string, to: string) {
  const acc = new Acc()
  const sorted = [...events].sort((a, b) => a.at - b.at)
  const byUser = new Map<number, MetricEvent[]>()
  for (const e of sorted) {
    if (!byUser.has(e.userId)) byUser.set(e.userId, [])
    byUser.get(e.userId)!.push(e)
  }
  const recordings = new Map<string, { day: string; segments: string[]; stops: number }>()

  for (const e of sorted) {
    const day = dayOf(e.at)
    if (day < from || day >= to) continue
    const s = eventSegments(e)
    const type = e.questionType
    const sw = type !== null && SW.has(type)
    switch (e.type) {
      case 'quiz_question_shown':
        if (type === 'SQ') acc.count(day, 'ev_sq_shown', s)
        if (type === 'WQ') acc.count(day, 'ev_wq_shown', s)
        if (sw) acc.rate(day, 'ev_timeout_rate', s, false)
        if (type === 'WQ') acc.rate(day, 'ev_paste_blocked_rate', s, false)
        break
      case 'quiz_record_started':
        acc.count(day, 'ev_record_started', s)
        acc.rate(day, 'ev_record_failed_share', s, false)
        break
      case 'quiz_record_failed':
        acc.count(day, 'ev_record_failed', [...s, seg('error', e.error)])
        acc.rate(day, 'ev_record_failed_share', s, true)
        break
      case 'quiz_record_stopped': {
        const secs = e.seconds ?? e.durationSec
        acc.value(day, 'ev_recorded_seconds', s, secs)
        if (type === 'SQ') {
          const key = `${e.userId}|${e.logId ?? '-'}|${e.questionId ?? '-'}|${day}`
          const cur = recordings.get(key) ?? { day, segments: s, stops: 0 }
          cur.stops++
          recordings.set(key, cur)
        }
        break
      }
      case 'quiz_answer_submitted':
        if (sw) acc.rate(day, 'ev_submit_failed_rate', s, false)
        break
      case 'quiz_submit_failed':
        if (sw) {
          acc.count(day, 'ev_submit_failed', [...s, seg('stage', e.stage)])
          acc.hit(day, 'ev_submit_failed_rate', s)
        }
        break
      case 'quiz_stt_result':
        acc.rate(day, 'ev_stt_no_speech_share', s, e.outcome === 'no_speech')
        acc.rate(day, 'ev_stt_failed_share', s, e.outcome === 'failed')
        break
      case 'quiz_eval_result':
        acc.rate(day, 'ev_eval_failed_share', s, e.outcome === 'failed')
        break
      case 'quiz_feedback_shown':
        acc.value(day, 'ev_feedback_wait_ms', s, e.ms)
        break
      case 'quiz_question_timeout':
        if (sw) {
          acc.hit(day, 'ev_timeout_rate', s)
          acc.rate(day, 'ev_timeout_stuck_share', s, stuckAfter(e, byUser.get(e.userId) ?? []))
        }
        break
      case 'quiz_paste_blocked':
        if (type === 'WQ') acc.hit(day, 'ev_paste_blocked_rate', s)
        break
    }
  }
  for (const r of recordings.values()) acc.rate(r.day, 'ev_rerecord_share', r.segments, r.stops > 1)
  return acc.rows()
}

/** A timeout the learner never got past: no feedback for that question, and no other question shown. */
export function stuckAfter(timeout: MetricEvent, userEvents: MetricEvent[]) {
  const t = timeout.at
  for (const e of userEvents) {
    if (e.at <= t) continue
    if (e.at > t + STUCK.movedOnWithinMs) break
    const sameAttempt = timeout.logId === null || e.logId === null || e.logId === timeout.logId
    if (!sameAttempt) continue
    if (e.type === 'quiz_feedback_shown' && e.questionId === timeout.questionId && e.at <= t + STUCK.feedbackWithinMs) return false
    if (e.type === 'quiz_question_shown' && e.questionId !== timeout.questionId) return false
  }
  return true
}

/** What one day's bills and answers say, for the cost rows. */
export interface CostDay {
  day: string
  speechInr: number
  speechBasis: Basis
  markingInr: number
  markingBasis: Basis
  sqAnswers: number
  markedAnswers: number
  answers: number
  finishedSwAttempts: number
  /** Google's billed seconds for quiz speech; null when the bill hasn't reported the day. */
  billedSeconds: number | null
  /** OpenAI usage for the quiz keys; null when not reported. */
  openaiRequests: number | null
  openaiTokens: number | null
}

const WORST: Basis[] = ['estimated', 'usage', 'actual']
export const worstBasis = (...b: Basis[]) => WORST.find((x) => b.includes(x)) ?? 'actual'

export function costMetrics(days: CostDay[]) {
  const acc = new Acc()
  for (const c of days) {
    const both = worstBasis(c.speechBasis, c.markingBasis)
    acc.set(c.day, 'cost_speech_inr', c.speechInr, 1, c.speechBasis)
    acc.set(c.day, 'cost_marking_inr', c.markingInr, 1, c.markingBasis)
    if (c.sqAnswers) acc.set(c.day, 'cost_speech_per_sq_inr', c.speechInr, c.sqAnswers, c.speechBasis)
    if (c.markedAnswers) acc.set(c.day, 'cost_marking_per_answer_inr', c.markingInr, c.markedAnswers, c.markingBasis)
    if (c.answers) acc.set(c.day, 'cost_per_answer_inr', c.speechInr + c.markingInr, c.answers, both)
    if (c.finishedSwAttempts) acc.set(c.day, 'cost_per_finished_sw_attempt_inr', c.speechInr + c.markingInr, c.finishedSwAttempts, both)
    if (c.billedSeconds !== null && c.sqAnswers) acc.set(c.day, 'stt_billed_seconds_per_sq', c.billedSeconds, c.sqAnswers, 'actual')
    if (c.openaiRequests !== null && c.markedAnswers) acc.set(c.day, 'openai_requests_per_marked', c.openaiRequests, c.markedAnswers, 'usage')
    if (c.openaiTokens !== null && c.markedAnswers) acc.set(c.day, 'openai_tokens_per_marked', c.openaiTokens, c.markedAnswers, 'usage')
  }
  return acc.rows()
}

/**
 * When a stored day stops changing. Answers, attempts and events settle within a couple of
 * days (an attempt can be finished the next day); a cost day waits for the provider's bill,
 * and is frozen as an estimate only once the bill is clearly not coming.
 */
export const SETTLE = { days: 3, estimatedCostDays: 21 }

export function isFinal(row: Pick<MetricRow, 'metric' | 'day' | 'basis'>, today: string) {
  const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.day}T00:00:00Z`)) / 86_400_000)
  if (age < SETTLE.days) return false
  if (METRIC_BY_KEY.get(row.metric)?.source === 'bills' && row.basis === 'estimated') return age >= SETTLE.estimatedCostDays
  return true
}

// ---- reading a window back (Impact tab, step 4 of the plan)

/** A window's value: SUM(num) / SUM(den) (count: SUM(num)), and the merged histogram. */
export function combine(def: MetricDef, rows: Pick<MetricRow, 'num' | 'den' | 'hist' | 'basis'>[]) {
  let num = 0
  let den = 0
  const hist = def.edges ? def.edges.map(() => 0) : null
  const bases = new Set<Basis>()
  for (const r of rows) {
    num += r.num
    den += r.den
    if (hist && r.hist) r.hist.forEach((v, i) => (hist[i] += v))
    if (r.basis) bases.add(r.basis)
  }
  const value = def.kind === 'count' ? num : den > 0 ? num / den : null
  return { num, den, value, hist, basis: bases.size ? worstBasis(...bases) : null }
}

/** The p-th percentile (0–100) of a merged histogram, interpolated inside its bucket. */
export function histQuantile(hist: number[], edges: number[], p: number) {
  const total = hist.reduce((s, v) => s + v, 0)
  if (!total) return null
  const target = (p / 100) * total
  let seen = 0
  for (let i = 0; i < hist.length; i++) {
    if (seen + hist[i] >= target && hist[i] > 0) {
      const lo = edges[i]
      const hi = edges[i + 1]
      if (hi === undefined) return lo
      return lo + ((hi - lo) * (target - seen)) / hist[i]
    }
    seen += hist[i]
  }
  return edges[edges.length - 1]
}
