import db from '@adonisjs/lucid/services/db'
import { DAY_MS, istDayLabel, istDayOf, istDayStart } from '#helpers/ist'
import quizAnalytics, { type AnswerRow } from '#services/analytics/quiz_analytics'
import {
  DEFINITION_VERSION,
  METRICS,
  METRIC_BY_KEY,
  answerMetrics,
  attemptMetrics,
  compareWindows,
  costMetrics,
  eventMetrics,
  impactWindows,
  isFinal,
  type AttemptDevice,
  type AttemptRow,
  type CostDay,
  type MetricRow,
} from '#services/analytics/quiz_metrics'
import { allocate, type AnswerFacts, type DayActuals, type Rates } from '#services/analytics/quiz_allocation'
import { providerActuals, ratesFor, type ProviderDbRow } from '#services/analytics/quiz_cost'
import { costModelStore } from '#services/analytics/cost_model'
import providerSync from '#services/analytics/provider_sync'
import { googleIsQuizSpeech, openaiIsQuiz } from '#services/analytics/cost_attribution'
import quizReleases from '#services/analytics/quiz_releases'

/**
 * Writes and reads console_quiz_daily_metrics (docs/QUIZ_OBSERVABILITY.md §7).
 *
 * A run computes every metric for a window of IST days from the live answer tables, the
 * app's events and the synced provider bills, a few days at a time, and replaces that
 * window's rows that are not final yet. Final rows (settled days, see isFinal) are left
 * exactly as they are unless `force`, so the "before" a fix is judged against never moves.
 */

/** The baseline starts here: the synced billing export covers 31 Aug 2026 on. */
export const BACKFILL_FROM = '2026-09-01'
/** Days per chunk: about 25k answers and their events at today's volume. */
const CHUNK_DAYS = 4
const TABLE = 'console_quiz_daily_metrics'
const n = (v: unknown) => Number(v ?? 0)
const dayNum = (label: string) => Math.round(Date.parse(`${label}T00:00:00Z`) / DAY_MS)

export interface QuizStart {
  userId: number
  quizId: number
  at: number
  device: string | null
  appVersion: string | null
}

/** How far before an attempt its quiz_start may be (the quiz screen opened, then the learner answered). */
export const START_MATCH = { beforeMs: 6 * 3_600_000, afterMs: 60_000 }

/**
 * The device and app version of an attempt or answer: the learner's latest quiz_start of that
 * quiz at most 6 h before it (a minute after, for clock skew). quiz_start carries no attempt
 * id, so this is the closest link there is; unmatched → null ("device:unknown").
 */
export function deviceMatcher(starts: QuizStart[]) {
  const byKey = new Map<string, QuizStart[]>()
  for (const s of starts) {
    const k = `${s.userId}|${s.quizId}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(s)
  }
  for (const list of byKey.values()) list.sort((a, b) => a.at - b.at)
  return (userId: number, quizId: number, atMs: number | null): AttemptDevice | null => {
    if (atMs === null) return null
    const list = byKey.get(`${userId}|${quizId}`)
    if (!list) return null
    let lo = 0
    let hi = list.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].at <= atMs + START_MATCH.afterMs) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (found < 0 || list[found].at < atMs - START_MATCH.beforeMs) return null
    return { device: list[found].device, appVersion: list[found].appVersion }
  }
}

/** Seconds in a GCP usage quantity, by its unit; null for a unit that isn't time. */
export function speechSeconds(unit: string, quantity: number) {
  const u = unit.toLowerCase()
  if (['s', 'second', 'seconds'].includes(u)) return quantity
  if (['min', 'minute', 'minutes'].includes(u)) return quantity * 60
  if (['h', 'hour', 'hours'].includes(u)) return quantity * 3600
  return null
}

const OPENAI_TOKENS = new Set(['input_tokens', 'cached_input_tokens', 'output_tokens'])

export interface RunResult {
  from: string
  to: string
  definitionVersion: number
  chunks: { from: string; to: string; rows: number; kept: number; answers: number; attempts: number; events: number }[]
  written: number
  keptFinal: number
}

class QuizMetricsStore {
  /**
   * Compute and store IST days [from, to] (labels, inclusive). `force` also rewrites final rows
   * (only after a definition bug fix; a new definition belongs in a new DEFINITION_VERSION).
   */
  async run({ from, to, force = false }: { from: string; to: string; force?: boolean }): Promise<RunResult> {
    const first = dayNum(from)
    const last = dayNum(to)
    if (!(first <= last)) throw new Error(`empty window ${from} → ${to}`)
    const result: RunResult = { from, to, definitionVersion: DEFINITION_VERSION, chunks: [], written: 0, keptFinal: 0 }
    const model = await costModelStore.get()
    const status = await providerSync.status()
    for (let start = first; start <= last; start += CHUNK_DAYS) {
      const end = Math.min(last + 1, start + CHUNK_DAYS)
      const c = await this.chunk(start, end, { force, model, status })
      result.chunks.push(c)
      result.written += c.rows
      result.keptFinal += c.kept
    }
    return result
  }

  private async chunk(
    fromDay: number,
    toDay: number,
    ctx: { force: boolean; model: Awaited<ReturnType<typeof costModelStore.get>>; status: Awaited<ReturnType<typeof providerSync.status>> }
  ) {
    const from = istDayLabel(fromDay)
    const to = istDayLabel(toDay)
    const fromMs = istDayStart(fromDay)
    const toMs = istDayStart(toDay)
    const [{ rows: answersRaw }, attemptsRaw, events, starts, providerRows] = await Promise.all([
      quizAnalytics.answersBetween(fromDay, toDay),
      quizAnalytics.attemptsBetween(fromDay, toDay),
      // 30 minutes past the window: "stuck after a timeout" looks ahead
      quizAnalytics.metricEventsBetween(fromMs, toMs + 30 * 60_000),
      quizAnalytics.quizStartsBetween(fromMs - DAY_MS, toMs + DAY_MS),
      db
        .from('console_ai_provider_daily')
        .where('day', '>=', from)
        .where('day', '<', to)
        .select(db.raw('DATE_FORMAT(day, "%Y-%m-%d") as day'), 'provider', 'scope', 'item', 'unit', 'quantity', 'cost_usd', 'credits_usd', 'source'),
    ])
    const answers = answersRaw.filter((a) => a.day >= from && a.day < to)
    const attempts = attemptsRaw.filter((a) => a.day >= from && a.day < to)
    const match = deviceMatcher(starts)
    const answerDevice = (a: AnswerRow) => match(a.userId, a.quizId, a.startMs ?? a.endMs)
    const attemptDevice = (a: AttemptRow) => match(a.userId, a.quizId, a.startMs)
    const dayOf = (ms: number) => istDayLabel(istDayOf(ms))

    const rows: MetricRow[] = [
      ...answerMetrics(answers, answerDevice, from, to),
      ...attemptMetrics(attempts, attemptDevice, from, to),
      ...eventMetrics(events, dayOf, from, to),
      ...costMetrics(this.costDays(fromDay, toDay, answers, attempts, events, providerRows, ctx)),
    ]
    const { written, kept } = await this.store(rows, from, to, ctx.force)
    return { from, to: istDayLabel(toDay - 1), rows: written, kept, answers: answers.length, attempts: attempts.length, events: events.length }
  }

  private costDays(
    fromDay: number,
    toDay: number,
    answers: AnswerRow[],
    attempts: AttemptRow[],
    events: Parameters<typeof quizAnalytics.recordedSeconds>[1],
    rawRows: Record<string, unknown>[],
    ctx: { model: Awaited<ReturnType<typeof costModelStore.get>>; status: Awaited<ReturnType<typeof providerSync.status>> }
  ): CostDay[] {
    const rows: ProviderDbRow[] = rawRows.map((r) => ({
      day: String(r.day),
      provider: String(r.provider),
      scope: String(r.scope),
      item: String(r.item),
      unit: String(r.unit),
      quantity: n(r.quantity),
      costUsd: n(r.cost_usd),
      creditsUsd: n(r.credits_usd),
      source: String(r.source),
    }))
    const { model, status } = ctx
    const labels = Array.from({ length: toDay - fromDay }, (_, i) => istDayLabel(fromDay + i))
    const actuals: Map<string, DayActuals> = providerActuals(
      rows,
      model,
      {
        google: { from: status.google.earliestDay, through: status.google.lastRun?.dataThrough ?? null },
        openai: { from: status.openai.earliestDay, through: status.openai.lastRun?.dataThrough ?? null },
      },
      status.rules
    ).actualsFor(labels)
    const recorded = quizAnalytics.recordedSeconds(answers, events)
    const facts: AnswerFacts[] = answers.map((a) => ({
      key: a.key,
      type: a.type,
      day: a.day,
      path: a.path,
      words: a.words,
      sentences: a.sentences,
      attempts: a.attempts,
      recordedSeconds: recorded.get(a.key) ?? null,
    }))
    const rateMemo = new Map<string, Rates>()
    const ratesOn = (day: string) => {
      if (!rateMemo.has(day)) rateMemo.set(day, ratesFor(model, day))
      return rateMemo.get(day)!
    }
    const { days: pools } = allocate(facts, actuals, ratesOn)

    const out: CostDay[] = []
    for (const day of labels) {
      const pool = pools.get(day)
      if (!pool) continue
      const act = actuals.get(day)
      let billedSeconds: number | null = null
      if (act?.speechInr !== undefined) {
        billedSeconds = 0
        for (const r of rows) {
          if (r.day !== day || r.provider !== 'google' || !googleIsQuizSpeech(r, status.rules)) continue
          billedSeconds += speechSeconds(r.unit, r.quantity) ?? 0
        }
      }
      let openaiRequests: number | null = null
      let openaiTokens: number | null = null
      if (act?.markingInr !== undefined) {
        openaiRequests = 0
        openaiTokens = 0
        for (const r of rows) {
          if (r.day !== day || r.source !== 'openai_usage_api' || openaiIsQuiz(r.scope, status.rules) === false) continue
          if (r.unit === 'requests') openaiRequests += r.quantity
          else if (OPENAI_TOKENS.has(r.unit)) openaiTokens += r.quantity
        }
      }
      out.push({
        day,
        speechInr: pool.speech.inr,
        speechBasis: pool.speech.basis,
        markingInr: pool.marking.inr,
        markingBasis: pool.marking.basis,
        sqAnswers: pool.speech.answers,
        markedAnswers: pool.marking.answers,
        answers: answers.filter((a) => a.day === day).length,
        finishedSwAttempts: attempts.filter((a) => a.day === day && a.finished && a.speakingWriting > 0).length,
        billedSeconds,
        openaiRequests,
        openaiTokens,
      })
    }
    return out
  }

  /** Replace the window's non-final rows; final rows stay unless `force`. */
  private async store(rows: MetricRow[], from: string, to: string, force: boolean) {
    const today = istDayLabel(istDayOf(Date.now()))
    const key = (r: { day: string; metric: string; segment: string }) => `${r.day}|${r.metric}|${r.segment}`
    let written = 0
    let kept = 0
    await db.transaction(async (trx) => {
      const window = () => trx.from(TABLE).where('definition_version', DEFINITION_VERSION).where('day', '>=', from).where('day', '<', to)
      const frozen = new Set<string>()
      if (!force) {
        for (const r of await window().where('final', true).select(trx.raw('DATE_FORMAT(day, "%Y-%m-%d") AS day'), 'metric', 'segment')) {
          frozen.add(key({ day: String(r.day), metric: String(r.metric), segment: String(r.segment) }))
        }
        await window().where('final', false).delete()
      } else {
        await window().delete()
      }
      kept = frozen.size
      const computedAt = new Date()
      const insert = rows
        .filter((r) => METRIC_BY_KEY.has(r.metric) && !frozen.has(key(r)))
        .map((r) => ({
          day: r.day,
          metric: r.metric,
          segment: r.segment.slice(0, 64),
          definition_version: DEFINITION_VERSION,
          num: r.num,
          den: r.den,
          hist: r.hist ? JSON.stringify(r.hist) : null,
          basis: r.basis,
          final: isFinal(r, today),
          computed_at: computedAt,
        }))
      for (let i = 0; i < insert.length; i += 500) await trx.table(TABLE).multiInsert(insert.slice(i, i + 500))
      written = insert.length
    })
    return { written, kept }
  }

  /** What the baseline holds: days stored, which are frozen, and from when each source has data. */
  async status() {
    const base = () => db.from(TABLE).where('definition_version', DEFINITION_VERSION)
    const span = await base()
      .select(
        db.raw('DATE_FORMAT(MIN(day), "%Y-%m-%d") AS first_day'),
        db.raw('DATE_FORMAT(MAX(day), "%Y-%m-%d") AS last_day'),
        db.raw('COUNT(DISTINCT day) AS days'),
        db.raw('MAX(computed_at) AS computed_at')
      )
      .first()
    const finalThrough = await base().where('final', true).select(db.raw('DATE_FORMAT(MAX(day), "%Y-%m-%d") AS d')).first()
    // By source, not by name: in LIKE an underscore matches any character (ev_% would match evidence_…)
    const firstOf = async (source: 'events' | 'bills') =>
      (
        await base()
          .whereIn(
            'metric',
            METRICS.filter((m) => m.source === source).map((m) => m.key)
          )
          .select(db.raw('DATE_FORMAT(MIN(day), "%Y-%m-%d") AS d'))
          .first()
      )?.d ?? null
    return {
      definitionVersion: DEFINITION_VERSION,
      backfillFrom: BACKFILL_FROM,
      firstDay: span?.first_day ?? null,
      lastDay: span?.last_day ?? null,
      days: n(span?.days),
      finalThrough: finalThrough?.d ?? null,
      lastComputedAt: span?.computed_at ?? null,
      eventsFrom: await firstOf('events'),
      costFrom: await firstOf('bills'),
    }
  }

  /** One metric's daily rows (a segment, a window), for charts and checks. */
  async series(metric: string, segment: string, from: string, to: string) {
    const rows = await db
      .from(TABLE)
      .where('definition_version', DEFINITION_VERSION)
      .where('metric', metric)
      .where('segment', segment)
      .where('day', '>=', from)
      .where('day', '<=', to)
      .orderBy('day', 'asc')
      .select(db.raw('DATE_FORMAT(day, "%Y-%m-%d") AS day'), 'num', 'den', 'hist', 'basis', 'final')
    return rows.map((r: Record<string, unknown>) => ({
      day: String(r.day),
      num: n(r.num),
      den: n(r.den),
      hist: r.hist === null || r.hist === undefined ? null : ((typeof r.hist === 'string' ? JSON.parse(r.hist) : r.hist) as number[]),
      basis: (r.basis as string) ?? null,
      final: !!r.final,
    }))
  }

  /**
   * Before vs after one logged change, for one segment: every stored metric over the window
   * before the deploy day and the window after it (impactWindows), compared by compareWindows.
   * Cost metrics only when `includeCost`. A change that hasn't reached learners has no windows.
   */
  async impact({ releaseId, segment = 'all', windowDays = 28, skipDays = 3, includeCost }: { releaseId: number; segment?: string; windowDays?: number; skipDays?: number; includeCost: boolean }) {
    const release = await quizReleases.find(releaseId)
    if (!release.deployedAt) return { release, segment, windows: null, metrics: [], segments: [] }
    const status = await this.status()
    const lastDay = status.lastDay ?? istDayLabel(istDayOf(Date.now()))
    const w = impactWindows(release.deployedAt, { windowDays, skipDays, lastDay })
    const to = w.after?.to ?? w.before.to
    const rows = (await db
      .from(TABLE)
      .where('definition_version', DEFINITION_VERSION)
      .where('segment', segment)
      .where('day', '>=', w.before.from)
      .where('day', '<=', to)
      .select(db.raw('DATE_FORMAT(day, "%Y-%m-%d") AS day'), 'metric', 'num', 'den', 'hist', 'basis')) as Record<string, unknown>[]
    const byMetric = new Map<string, { before: MetricRow[]; after: MetricRow[] }>()
    for (const r of rows) {
      const day = String(r.day)
      const row: MetricRow = {
        day,
        metric: String(r.metric),
        segment,
        num: n(r.num),
        den: n(r.den),
        hist: r.hist === null || r.hist === undefined ? null : ((typeof r.hist === 'string' ? JSON.parse(r.hist) : r.hist) as number[]),
        basis: (r.basis as MetricRow['basis']) ?? null,
      }
      const side = day >= w.before.from && day <= w.before.to ? 'before' : w.after && day >= w.after.from && day <= w.after.to ? 'after' : null
      if (!side) continue
      if (!byMetric.has(row.metric)) byMetric.set(row.metric, { before: [], after: [] })
      byMetric.get(row.metric)![side].push(row)
    }
    const expected = new Map((release.expects ?? []).map((e) => [e.metric, e.direction]))
    const metrics = METRICS.filter((d) => includeCost || d.source !== 'bills')
      .filter((d) => byMetric.has(d.key))
      .map((d) => {
        const sides = byMetric.get(d.key)!
        return {
          key: d.key,
          label: d.label,
          kind: d.kind,
          source: d.source,
          unit: d.unit,
          better: d.better,
          phases: d.phases,
          how: d.how,
          expected: expected.get(d.key) ?? null,
          ...compareWindows(d, sides.before, sides.after, w.after?.days ?? 0),
        }
      })
    // Segments worth offering: those with answers or app events across the two windows
    const segments = (await db
      .from(TABLE)
      .where('definition_version', DEFINITION_VERSION)
      .whereIn('metric', ['sq_answers', 'wq_answers', 'ev_sq_shown', 'ev_wq_shown'])
      .where('day', '>=', w.before.from)
      .where('day', '<=', to)
      .groupBy('segment')
      .select('segment', db.raw('SUM(num) AS n'))
      .orderByRaw('SUM(num) DESC')
      .limit(30)) as { segment: string; n: unknown }[]
    return { release, segment, windows: w, metrics, segments: segments.map((s) => ({ segment: String(s.segment), answers: n(s.n) })) }
  }

  /** Segments a metric has rows for in a window (device:web, os:ios, …), most answers first. */
  async segments(metric: string, from: string, to: string) {
    const rows = await db
      .from(TABLE)
      .where('definition_version', DEFINITION_VERSION)
      .where('metric', metric)
      .where('day', '>=', from)
      .where('day', '<=', to)
      .groupBy('segment')
      .select('segment', db.raw('SUM(den) AS den'), db.raw('SUM(num) AS num'))
      // counts keep their size in num, the rest in den
      .orderByRaw('SUM(den) DESC, SUM(num) DESC')
      .limit(50)
    return rows.map((r: Record<string, unknown>) => ({ segment: String(r.segment), den: n(r.den), num: n(r.num) }))
  }
}

export default new QuizMetricsStore()
