import db from '@adonisjs/lucid/services/db'
import { DAY_MS, istDayLabel, istDayOf, istDayStart } from '#helpers/ist'
import { costModelStore, priceFor, unitPriceInr, type CostModel } from '#services/analytics/cost_model'
import quizAnalytics, { summary, type AnswerRow, type MarkingPath } from '#services/analytics/quiz_analytics'
import { allocate, type AnswerFacts, type Basis, type DayActuals, type Rates } from '#services/analytics/quiz_allocation'
import providerSync from '#services/analytics/provider_sync'
import { isSpeechSku } from '#services/analytics/gcp_billing'

/**
 * Quiz AI cost (Cost page → Quizzes). Actual daily spend comes from the providers' own data
 * in console_ai_provider_daily (OpenAI Costs API for marking, the GCP billing export for
 * speech-to-text); each day's actual is spread over that day's answers by weight
 * (quiz_allocation.ts). Days the providers haven't reported (not connected, export not yet
 * in) are ESTIMATED from the rate card and labelled. Figures in ₹ at the price list's USD rate.
 */

const CACHE_MS = 120_000
const PATHS: MarkingPath[] = ['legacy', 'counted', 'evidence']
const n = (v: unknown) => Number(v ?? 0)
/** gpt-4o-mini-2024-07-18 → gpt-4o-mini: snapshots are priced on the model's line. */
export const priceModelOf = (model: string) => model.replace(/-\d{4}-\d{2}-\d{2}$/, '')

interface ProviderDbRow {
  day: string
  provider: string
  scope: string
  item: string
  unit: string
  quantity: number
  costUsd: number
  source: string
}

export function ratesFor(model: CostModel, day: string): Rates {
  const inr = (provider: string, m: string, unit: string) => {
    const line = priceFor(model, provider, m, unit, day)
    return line ? unitPriceInr(line, model.usdToInr) : 0
  }
  return {
    speechPerSecondInr: inr('google', 'speech-v2-standard', 'audio_seconds'),
    inputPerTokenInr: inr('openai', 'gpt-4o-mini', 'input_tokens'),
    outputPerTokenInr: inr('openai', 'gpt-4o-mini', 'output_tokens'),
  }
}

/**
 * What the providers reported per day, as ₹ per pool, and which days they cover:
 * a day counts as reported once the provider's data runs past its end; before the first
 * synced day, or after the last complete one, the day is left to the estimate.
 */
export function providerActuals(
  rows: ProviderDbRow[],
  model: CostModel,
  coverage: { google: { from: string | null; through: string | null }; openai: { from: string | null; through: string | null } },
  speechProject: string | null
) {
  const actuals = new Map<string, DayActuals>()
  const unpriced = new Set<string>()
  const google = new Map<string, number>()
  const openaiCost = new Map<string, number>()
  const openaiUsage = new Map<string, number>()
  for (const r of rows) {
    if (r.provider === 'google') {
      if (speechProject && r.scope !== speechProject) continue
      if (isSpeechSku(r.item)) google.set(r.day, (google.get(r.day) ?? 0) + r.costUsd * model.usdToInr)
    } else if (r.provider === 'openai' && r.source === 'openai_costs_api') {
      openaiCost.set(r.day, (openaiCost.get(r.day) ?? 0) + r.costUsd * model.usdToInr)
    } else if (r.provider === 'openai' && r.source === 'openai_usage_api' && r.unit !== 'requests') {
      const line = priceFor(model, 'openai', priceModelOf(r.item), r.unit, r.day)
      if (!line) unpriced.add(`${r.item} ${r.unit}`)
      openaiUsage.set(r.day, (openaiUsage.get(r.day) ?? 0) + (line ? r.quantity * unitPriceInr(line, model.usdToInr) : 0))
    }
  }
  const covered = (day: string, c: { from: string | null; through: string | null }, end: number) =>
    !!c.from && !!c.through && day >= c.from && Date.parse(c.through) >= end
  const days = new Set([...rows.map((r) => r.day)])
  return {
    unpriced: [...unpriced],
    actualsFor(allDays: string[]) {
      for (const day of new Set([...allDays, ...days])) {
        const dayNum = Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS)
        const a: DayActuals = {}
        // Google's export: complete once usage up to the end of the IST day is in
        if (covered(day, coverage.google, istDayStart(dayNum + 1))) a.speechInr = google.get(day) ?? 0
        // OpenAI's buckets are UTC days labelled by their IST start date
        if (covered(day, coverage.openai, (dayNum + 1) * DAY_MS)) {
          if (openaiCost.has(day)) {
            a.markingInr = openaiCost.get(day)!
            a.markingBasis = 'actual'
          } else if (openaiUsage.has(day)) {
            a.markingInr = openaiUsage.get(day)!
            a.markingBasis = 'usage'
          } else {
            a.markingInr = 0
            a.markingBasis = 'actual'
          }
        }
        if (a.speechInr !== undefined || a.markingInr !== undefined) actuals.set(day, a)
      }
      return actuals
    },
  }
}

class QuizCostService {
  #cache = new Map<string, { at: number; value: unknown }>()

  clearCache() {
    this.#cache.clear()
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T
    const value = await fn()
    this.#cache.set(key, { at: Date.now(), value })
    return value
  }

  cost(days: number) {
    return this.cached(`cost:${days}`, async () => {
      const today = istDayOf(Date.now())
      const firstDay = today - days + 1
      const firstLabel = istDayLabel(firstDay)
      const model = await costModelStore.get()
      const [{ rows: answers, sources }, events, status, rawRows] = await Promise.all([
        quizAnalytics.answers(days),
        quizAnalytics.events(days),
        providerSync.status(),
        db
          .from('console_ai_provider_daily')
          .where('day', '>=', firstLabel)
          .select(db.raw('DATE_FORMAT(day, "%Y-%m-%d") as day'), 'provider', 'scope', 'item', 'unit', 'quantity', 'cost_usd', 'source'),
      ])
      const rows: ProviderDbRow[] = rawRows.map((r: Record<string, unknown>) => ({
        day: String(r.day),
        provider: String(r.provider),
        scope: String(r.scope),
        item: String(r.item),
        unit: String(r.unit),
        quantity: n(r.quantity),
        costUsd: n(r.cost_usd),
        source: String(r.source),
      }))

      const recorded = quizAnalytics.recordedSeconds(answers, events.rows)
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
      const dayLabels = Array.from({ length: days }, (_, i) => istDayLabel(firstDay + i))
      const reported = providerActuals(
        rows,
        model,
        {
          google: { from: status.google.earliestDay, through: status.google.lastRun?.dataThrough ?? null },
          openai: { from: status.openai.earliestDay, through: status.openai.lastRun?.dataThrough ?? null },
        },
        status.google.projectId
      )
      const actuals = reported.actualsFor(dayLabels)
      const rateMemo = new Map<string, Rates>()
      const ratesOn = (day: string) => {
        if (!rateMemo.has(day)) rateMemo.set(day, ratesFor(model, day))
        return rateMemo.get(day)!
      }
      const { answers: allocated, days: dayPools } = allocate(facts, actuals, ratesOn)
      const byKey = new Map(allocated.map((a) => [a.key, a]))
      const inWindow = (day: string) => day >= firstLabel

      // --- per answer
      const costOf = (a: AnswerRow) => {
        const c = byKey.get(a.key)!
        return { total: c.speechInr + c.markingInr, ...c }
      }
      const isActual = (c: { speechBasis: Basis | null; markingBasis: Basis | null }) =>
        [c.speechBasis, c.markingBasis].every((b) => b === null || b !== 'estimated') && (c.speechBasis !== null || c.markingBasis !== null)
      const typeStats = (type: 'SQ' | 'WQ') => {
        const list = answers.filter((a) => a.type === type)
        const costs = list.map(costOf)
        const actual = costs.filter(isActual)
        return {
          ...summary(costs.map((c) => c.total)),
          speech: summary(costs.map((c) => c.speechInr)).mean,
          marking: summary(costs.map((c) => c.markingInr)).mean,
          actualAnswers: actual.length,
          /** The same figures over answers whose day the providers reported (no estimate inside). */
          actualOnly: summary(actual.map((c) => c.total)),
        }
      }
      const byPath = (['SQ', 'WQ'] as const).flatMap((type) =>
        PATHS.map((path) => {
          const list = answers.filter((a) => a.type === type && a.path === path)
          const costs = list.map(costOf)
          return {
            type,
            path,
            ...summary(costs.map((c) => c.total)),
            avgInputTokens: summary(costs.map((c) => c.estimate.tokens.input)).mean,
            avgOutputTokens: summary(costs.map((c) => c.estimate.tokens.output)).mean,
            avgCalls: summary(costs.map((c) => c.estimate.tokens.calls)).mean,
            avgSpeechSeconds: type === 'SQ' ? summary(costs.map((c) => c.estimate.speechSeconds)).mean : null,
            recordedShare: type === 'SQ' && costs.length ? Math.round((costs.filter((c) => c.estimate.speechFrom === 'recording').length / costs.length) * 1000) / 10 : null,
          }
        }).filter((p) => p.count > 0)
      )

      // --- per quiz, per learner
      const groupBy = (keyOf: (a: AnswerRow) => number) => {
        const m = new Map<number, { answers: number; costInr: number; actual: number }>()
        for (const a of answers) {
          const c = costOf(a)
          const cur = m.get(keyOf(a)) ?? { answers: 0, costInr: 0, actual: 0 }
          cur.answers++
          cur.costInr += c.total
          if (isActual(c)) cur.actual++
          m.set(keyOf(a), cur)
        }
        return [...m.entries()].sort((x, y) => y[1].costInr - x[1].costInr).slice(0, 10)
      }
      const quizzes = groupBy((a) => a.quizId)
      const names = await quizAnalytics.quizNames(quizzes.map(([id]) => id))

      // --- per day
      const series = dayLabels.map((day) => {
        const pools = dayPools.get(day)
        const onDay = answers.filter((a) => a.day === day)
        return {
          day,
          sq: onDay.filter((a) => a.type === 'SQ').length,
          wq: onDay.filter((a) => a.type === 'WQ').length,
          speechInr: pools?.speech.inr ?? 0,
          markingInr: pools?.marking.inr ?? 0,
          speechBasis: pools?.speech.basis ?? (actuals.get(day)?.speechInr !== undefined ? 'actual' : 'estimated'),
          markingBasis: pools?.marking.basis ?? (actuals.get(day)?.markingInr !== undefined ? (actuals.get(day)?.markingBasis ?? 'actual') : 'estimated'),
          estimatedSpeechInr: pools?.speech.estimatedInr ?? 0,
          estimatedMarkingInr: pools?.marking.estimatedInr ?? 0,
          unallocatedInr: (pools?.speech.unallocatedInr ?? 0) + (pools?.marking.unallocatedInr ?? 0),
        }
      })
      const sum = (f: (s: (typeof series)[number]) => number) => series.reduce((s, d) => s + f(d), 0)
      const actualOf = (pool: 'speech' | 'marking') => sum((d) => (d[`${pool}Basis`] === 'estimated' ? 0 : d[`${pool}Inr`]))
      const estimatedOf = (pool: 'speech' | 'marking') => sum((d) => (d[`${pool}Basis`] === 'estimated' ? d[`${pool}Inr`] : 0))

      // --- what the providers reported, item by item (shown, so a mis-classified SKU is visible)
      const items = new Map<string, { provider: string; scope: string; item: string; unit: string; quantity: number; costInr: number; counted: string }>()
      for (const r of rows.filter((x) => inWindow(x.day))) {
        const counted =
          r.provider === 'google'
            ? status.google.projectId && r.scope !== status.google.projectId
              ? 'other project'
              : isSpeechSku(r.item)
                ? 'speech-to-text'
                : 'not quiz (shown only)'
            : r.source === 'openai_costs_api'
              ? 'marking (billed)'
              : 'marking (usage)'
        const key = `${r.provider}|${r.scope}|${r.item}|${r.unit}|${r.source}`
        const cur = items.get(key) ?? { provider: r.provider, scope: r.scope, item: r.item, unit: r.unit, quantity: 0, costInr: 0, counted }
        cur.quantity += r.quantity
        cur.costInr += r.costUsd * model.usdToInr
        items.set(key, cur)
      }

      // --- calibration: estimated vs what the providers counted, on days both exist
      const usageDays = new Set(rows.filter((r) => r.source === 'openai_usage_api').map((r) => r.day))
      const speechDays = new Set(rows.filter((r) => r.provider === 'google' && isSpeechSku(r.item)).map((r) => r.day))
      const est = (pred: (day: string) => boolean, f: (c: ReturnType<typeof costOf>) => number) =>
        answers.filter((a) => pred(a.day)).reduce((s, a) => s + f(costOf(a)), 0)
      const actualQty = (pred: (r: ProviderDbRow) => boolean) => rows.filter(pred).reduce((s, r) => s + r.quantity, 0)
      const calibration = {
        marking: usageDays.size
          ? {
              days: usageDays.size,
              estimatedCalls: est((d) => usageDays.has(d), (c) => c.estimate.tokens.calls),
              actualRequests: actualQty((r) => r.source === 'openai_usage_api' && r.unit === 'requests'),
              estimatedInputTokens: est((d) => usageDays.has(d), (c) => c.estimate.tokens.input),
              actualInputTokens: actualQty((r) => r.source === 'openai_usage_api' && (r.unit === 'input_tokens' || r.unit === 'cached_input_tokens')),
              estimatedOutputTokens: est((d) => usageDays.has(d), (c) => c.estimate.tokens.output),
              actualOutputTokens: actualQty((r) => r.source === 'openai_usage_api' && r.unit === 'output_tokens'),
            }
          : null,
        speech: speechDays.size
          ? {
              days: speechDays.size,
              estimatedSeconds: est((d) => speechDays.has(d), (c) => c.estimate.speechSeconds),
              billedQuantity: actualQty((r) => r.provider === 'google' && isSpeechSku(r.item) && (!status.google.projectId || r.scope === status.google.projectId)),
              billedUnits: [...new Set(rows.filter((r) => r.provider === 'google' && isSpeechSku(r.item)).map((r) => r.unit))],
            }
          : null,
      }

      const totalInr = sum((d) => d.speechInr + d.markingInr)
      return {
        days,
        empty: !sources.some((s) => s.present) ? 'no_tables' : answers.length ? null : 'no_answers',
        sources,
        providers: status,
        usdToInr: model.usdToInr,
        priceLines: model.prices.filter((p) => (p.provider === 'openai' && p.model.startsWith('gpt')) || p.model.startsWith('speech-')),
        unpriced: reported.unpriced,
        totals: {
          totalInr,
          actualInr: actualOf('speech') + actualOf('marking'),
          estimatedInr: estimatedOf('speech') + estimatedOf('marking'),
          speechInr: sum((d) => d.speechInr),
          markingInr: sum((d) => d.markingInr),
          speechActualInr: actualOf('speech'),
          markingActualInr: actualOf('marking'),
          unallocatedInr: sum((d) => d.unallocatedInr),
          answers: answers.length,
          sq: answers.filter((a) => a.type === 'SQ').length,
          wq: answers.filter((a) => a.type === 'WQ').length,
          actualAnswers: allocated.filter(isActual).length,
          monthlyRunRateInr: (totalInr / days) * 30,
        },
        perAnswer: { SQ: typeStats('SQ'), WQ: typeStats('WQ') },
        byPath,
        series,
        topQuizzes: quizzes.map(([quizId, v]) => ({ quizId, name: names.get(quizId) ?? null, ...v, perAnswerInr: v.costInr / v.answers })),
        topLearners: groupBy((a) => a.userId).map(([userId, v]) => ({ userId, ...v, perAnswerInr: v.costInr / v.answers })),
        providerItems: [...items.values()].sort((a, b) => b.costInr - a.costInr),
        calibration,
      }
    })
  }
}

export default new QuizCostService()
