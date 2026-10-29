import db from '@adonisjs/lucid/services/db'
import { DAY_MS, istDayLabel, istDayOf, istDayStart } from '#helpers/ist'
import { costModelStore, priceFor, unitPriceInr, type CostModel } from '#services/analytics/cost_model'
import costService from '#services/analytics/cost_service'
import providerSync from '#services/analytics/provider_sync'
import { BUCKETS, TUTOR_GEMINI_PROJECT, attribute, openaiIsQuiz, splitScope, type AttributionRules, type Bucket } from '#services/analytics/cost_attribution'
import { splitItem } from '#services/analytics/gcp_billing'
import { priceModelOf, type ProviderDbRow } from '#services/analytics/quiz_cost'

/**
 * The whole provider bill (Cost page → Full bill): every GCP project/service/SKU on the
 * billing account and every OpenAI project/key/model, as the providers themselves report
 * them (console_ai_provider_daily), net = gross + credits; plus Finance's monthly bills for
 * providers without a billing API (console_cost_invoices: Sarvam, LiveKit, other) as their
 * own line. Each total is split into AI tutor / quizzes / everything else by the read-time
 * attribution rules. The AI tutor's usage-priced cost (cost_service) is shown NEXT to the
 * billed figures for the same provider, never added to them.
 */

const CACHE_MS = 120_000
const MONTHS = 6
const n = (v: unknown) => Number(v ?? 0)
const PROVIDER_LABEL: Record<string, string> = { sarvam: 'Sarvam', google: 'Google', livekit: 'LiveKit', other: 'Other', openai: 'OpenAI' }

type Split = Record<Bucket, number>
const emptySplit = (): Split => ({ quizzes: 0, tutor: 0, other: 0 })
const addSplit = (into: Split, from: Partial<Split>) => {
  for (const b of BUCKETS) into[b] += from[b] ?? 0
}

/** OpenAI's daily charge split by the rules; costs not broken down by key are split by the quiz keys' usage at list price. */
export function openaiDaySplit(costs: ProviderDbRow[], quizUsageInr: number, rules: AttributionRules, usdToInr: number) {
  const split = emptySplit()
  let unknown = 0
  let total = 0
  for (const r of costs) {
    const inr = (r.costUsd + r.creditsUsd) * usdToInr
    total += inr
    const quiz = openaiIsQuiz(r.scope, rules)
    if (quiz === null) unknown += inr
    else split[quiz ? 'quizzes' : 'other'] += inr
  }
  if (unknown) {
    const quiz = Math.min(unknown, quizUsageInr)
    split.quizzes += quiz
    split.other += unknown - quiz
  }
  return { total, split, splitByUsage: unknown > 0 }
}

function usageInr(rows: ProviderDbRow[], model: CostModel) {
  let inr = 0
  for (const r of rows) {
    if (r.unit === 'requests') continue
    const line = priceFor(model, 'openai', priceModelOf(r.item), r.unit, r.day)
    if (line) inr += r.quantity * unitPriceInr(line, model.usdToInr)
  }
  return inr
}

class FullBillService {
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

  bill(days: number) {
    return this.cached(`bill:${days}`, async () => {
      const today = istDayOf(Date.now())
      const firstDay = today - days + 1
      const firstLabel = istDayLabel(firstDay)
      const now = new Date(Date.now() + 19_800_000)
      const months = Array.from({ length: MONTHS }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1 - i), 1)).toISOString().slice(0, 7))
      const from = `${months[0]}-01` < firstLabel ? `${months[0]}-01` : firstLabel
      const [model, status, raw, invoices, recon, tutorCost] = await Promise.all([
        costModelStore.get(),
        providerSync.status(),
        db
          .from('console_ai_provider_daily')
          .where('day', '>=', from)
          .select(db.raw('DATE_FORMAT(day, "%Y-%m-%d") as day'), 'provider', 'scope', 'item', 'unit', 'quantity', 'cost_usd', 'credits_usd', 'source'),
        db.from('console_cost_invoices').where('month', '>=', months[0]).select('month', 'provider', 'amount_inr', 'note', 'updated_at'),
        costService.reconciliation(MONTHS),
        costService.cost(days),
      ])
      const rules = status.rules
      const usd = model.usdToInr
      const rows: ProviderDbRow[] = raw.map((r: Record<string, unknown>) => ({
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
      const google = rows.filter((r) => r.source === 'gcp_billing_export')
      const costs = rows.filter((r) => r.source === 'openai_costs_api')
      const usage = rows.filter((r) => r.source === 'openai_usage_api')
      const quizUsage = usage.filter((r) => openaiIsQuiz(r.scope, rules) !== false)

      // --- completeness: a day is complete once the source's data runs past its end
      const googleThrough = status.google.lastRun?.dataThrough ? Date.parse(status.google.lastRun.dataThrough) : null
      const openaiThrough = status.openai.lastRun?.dataThrough ? Date.parse(status.openai.lastRun.dataThrough) : null
      const dayNum = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS)
      const googleComplete = (day: string) => googleThrough !== null && !!status.google.earliestDay && day >= status.google.earliestDay && googleThrough >= istDayStart(dayNum(day) + 1)
      const openaiComplete = (day: string) => openaiThrough !== null && !!status.openai.earliestDay && day >= status.openai.earliestDay && openaiThrough >= (dayNum(day) + 1) * DAY_MS

      // --- per day (window)
      const byDay = <T extends ProviderDbRow>(list: T[]) => {
        const m = new Map<string, T[]>()
        for (const r of list) {
          if (!m.has(r.day)) m.set(r.day, [])
          m.get(r.day)!.push(r)
        }
        return m
      }
      const googleByDay = byDay(google)
      const costsByDay = byDay(costs)
      const usageByDay = byDay(usage)
      const quizUsageByDay = byDay(quizUsage)
      const dayFigures = (day: string) => {
        const g = googleByDay.get(day) ?? []
        const split = emptySplit()
        let gross = 0
        let credits = 0
        let speech = 0
        for (const r of g) {
          gross += r.costUsd * usd
          credits += r.creditsUsd * usd
          const a = attribute(r, rules)
          split[a.bucket ?? 'other'] += (r.costUsd + r.creditsUsd) * usd
          if (a.part === 'speech') speech += (r.costUsd + r.creditsUsd) * usd
        }
        const c = costsByDay.get(day)
        let openai = 0
        let openaiBasis: 'billed' | 'usage' | 'none' = 'none'
        let marking = 0
        let splitByUsage = false
        if (c?.length) {
          const o = openaiDaySplit(c, usageInr(quizUsageByDay.get(day) ?? [], model), rules, usd)
          openai = o.total
          addSplit(split, o.split)
          marking = o.split.quizzes
          openaiBasis = 'billed'
          splitByUsage = o.splitByUsage
        } else if (usageByDay.get(day)?.length) {
          // Costs API missing for this day: OpenAI's own token counts at list price
          openai = usageInr(usageByDay.get(day)!, model)
          marking = usageInr(quizUsageByDay.get(day) ?? [], model)
          split.quizzes += marking
          split.other += openai - marking
          openaiBasis = 'usage'
        }
        return { googleGross: gross, googleCredits: credits, googleNet: gross + credits, speech, openai, openaiBasis, marking, split, splitByUsage, googleReported: g.length > 0 }
      }
      const series = Array.from({ length: days }, (_, i) => {
        const day = istDayLabel(firstDay + i)
        const f = dayFigures(day)
        return {
          day,
          openaiInr: f.openai,
          openaiBasis: f.openaiBasis,
          googleGrossInr: f.googleGross,
          googleCreditsInr: f.googleCredits,
          googleNetInr: f.googleNet,
          totalInr: f.openai + f.googleNet,
          quizzesInr: f.split.quizzes,
          tutorInr: f.split.tutor,
          otherInr: f.split.other,
          speechInr: f.speech,
          markingInr: f.marking,
          googleComplete: googleComplete(day),
          openaiComplete: openaiComplete(day),
          complete: (!status.google.connected && !googleThrough ? true : googleComplete(day)) && (!status.openai.connected && !openaiThrough ? true : openaiComplete(day)),
        }
      })
      const sumSeries = (f: (s: (typeof series)[number]) => number) => series.reduce((s, d) => s + f(d), 0)

      // --- per month, with Finance's bills for providers that have no billing API
      const googleMonths = new Set(google.map((r) => r.day.slice(0, 7)))
      const monthRows = months.map((month) => {
        const daysIn = [...new Set(rows.filter((r) => r.day.startsWith(month)).map((r) => r.day))]
        const split = emptySplit()
        let openai = 0
        let gGross = 0
        let gCredits = 0
        let openaiUsageDays = 0
        for (const day of daysIn) {
          const f = dayFigures(day)
          openai += f.openai
          gGross += f.googleGross
          gCredits += f.googleCredits
          addSplit(split, f.split)
          if (f.openaiBasis === 'usage') openaiUsageDays++
        }
        const manual = invoices
          .filter((i) => i.month === month)
          .map((i) => {
            // The export already has Google's charges for a month it covers: Finance's Google
            // figure is shown, not added (it would count them twice).
            const counted = !(i.provider === 'google' && googleMonths.has(month))
            const bucket: Bucket = i.provider === 'sarvam' || i.provider === 'livekit' || i.provider === 'google' ? 'tutor' : 'other'
            return { provider: i.provider as string, label: PROVIDER_LABEL[i.provider] ?? i.provider, amountInr: n(i.amount_inr), note: (i.note as string) ?? null, counted, bucket }
          })
        for (const m of manual) if (m.counted) split[m.bucket] += m.amountInr
        const manualInr = manual.filter((m) => m.counted).reduce((s, m) => s + m.amountInr, 0)
        return {
          month,
          openaiInr: openai,
          openaiUsageDays,
          googleGrossInr: gGross,
          googleCreditsInr: gCredits,
          googleNetInr: gGross + gCredits,
          manual,
          manualInr,
          totalInr: openai + gGross + gCredits + manualInr,
          split,
          coverage: {
            googleDays: new Set(google.filter((r) => r.day.startsWith(month)).map((r) => r.day)).size,
            openaiDays: new Set([...costs, ...usage].filter((r) => r.day.startsWith(month)).map((r) => r.day)).size,
          },
        }
      })

      // --- GCP: project → service → top SKUs (window)
      const inWindow = (r: ProviderDbRow) => r.day >= firstLabel
      const projects = new Map<string, { project: string; grossInr: number; creditsInr: number; netInr: number; split: Split; services: Map<string, { service: string; grossInr: number; creditsInr: number; netInr: number; skus: Map<string, { sku: string; unit: string; quantity: number; netInr: number; bucket: Bucket }> }> }>()
      for (const r of google.filter(inWindow)) {
        const p = projects.get(r.scope) ?? { project: r.scope, grossInr: 0, creditsInr: 0, netInr: 0, split: emptySplit(), services: new Map() }
        projects.set(r.scope, p)
        const { service, sku } = splitItem(r.item)
        const s = p.services.get(service) ?? { service, grossInr: 0, creditsInr: 0, netInr: 0, skus: new Map() }
        p.services.set(service, s)
        const bucket = attribute(r, rules).bucket ?? 'other'
        const k = `${sku}|${r.unit}`
        const k2 = s.skus.get(k) ?? { sku, unit: r.unit, quantity: 0, netInr: 0, bucket }
        s.skus.set(k, k2)
        const gross = r.costUsd * usd
        const credits = r.creditsUsd * usd
        for (const x of [p, s]) {
          x.grossInr += gross
          x.creditsInr += credits
          x.netInr += gross + credits
        }
        p.split[bucket] += gross + credits
        k2.quantity += r.quantity
        k2.netInr += gross + credits
      }
      const gcp = [...projects.values()]
        .sort((a, b) => b.netInr - a.netInr)
        .map((p) => ({
          project: p.project,
          grossInr: p.grossInr,
          creditsInr: p.creditsInr,
          netInr: p.netInr,
          split: p.split,
          role: p.project === TUTOR_GEMINI_PROJECT ? 'AI tutor (Gemini)' : rules.speechProject === p.project ? 'quiz speech-to-text project' : null,
          services: [...p.services.values()]
            .sort((a, b) => b.netInr - a.netInr)
            .map((s) => ({
              service: s.service,
              grossInr: s.grossInr,
              creditsInr: s.creditsInr,
              netInr: s.netInr,
              skus: [...s.skus.values()].sort((a, b) => Math.abs(b.netInr) - Math.abs(a.netInr)).slice(0, 5),
              moreSkus: Math.max(0, s.skus.size - 5),
            })),
        }))

      // --- OpenAI: by project, model and key (window)
      const wCosts = costs.filter(inWindow)
      const wUsage = usage.filter(inWindow)
      const group = <T>(list: ProviderDbRow[], keyOf: (r: ProviderDbRow) => string, init: () => T, add: (acc: T, r: ProviderDbRow) => void) => {
        const m = new Map<string, T>()
        for (const r of list) {
          const k = keyOf(r)
          if (!m.has(k)) m.set(k, init())
          add(m.get(k)!, r)
        }
        return m
      }
      const tokens = () => ({ inputTokens: 0, outputTokens: 0, requests: 0, listInr: 0 })
      const addTokens = (acc: ReturnType<typeof tokens>, r: ProviderDbRow) => {
        if (r.unit === 'input_tokens' || r.unit === 'cached_input_tokens') acc.inputTokens += r.quantity
        else if (r.unit === 'output_tokens') acc.outputTokens += r.quantity
        else if (r.unit === 'requests') acc.requests += r.quantity
        acc.listInr += usageInr([r], model)
      }
      const projectCost = group(wCosts, (r) => splitScope(r.scope).project, () => ({ inr: 0 }), (a, r) => (a.inr += (r.costUsd + r.creditsUsd) * usd))
      const projectUsage = group(wUsage, (r) => splitScope(r.scope).project, tokens, addTokens)
      const modelCost = group(wCosts, (r) => r.item.split(',')[0].trim(), () => ({ inr: 0 }), (a, r) => (a.inr += (r.costUsd + r.creditsUsd) * usd))
      const modelUsage = group(wUsage, (r) => r.item, tokens, addTokens)
      const keyCost = group(wCosts.filter((r) => splitScope(r.scope).key !== null), (r) => r.scope, () => ({ inr: 0 }), (a, r) => (a.inr += (r.costUsd + r.creditsUsd) * usd))
      const keyUsage = group(wUsage, (r) => r.scope, tokens, addTokens)
      const quizOf = (scope: string) => openaiIsQuiz(scope, rules)
      const openai = {
        costsByKey: status.openai.lastRun?.costsByKey ?? null,
        byProject: [...new Set([...projectCost.keys(), ...projectUsage.keys()])]
          .map((project) => ({ project, billedInr: projectCost.get(project)?.inr ?? null, ...(projectUsage.get(project) ?? tokens()), quiz: quizOf(project) }))
          .sort((a, b) => (b.billedInr ?? b.listInr) - (a.billedInr ?? a.listInr)),
        byModel: [...new Set([...modelCost.keys(), ...modelUsage.keys()].map((m) => m))]
          .map((m) => ({ model: m, billedInr: modelCost.get(m)?.inr ?? null, ...(modelUsage.get(m) ?? tokens()) }))
          .sort((a, b) => (b.billedInr ?? b.listInr) - (a.billedInr ?? a.listInr)),
        byKey: [...new Set([...keyCost.keys(), ...keyUsage.keys()])]
          .map((scope) => ({ ...splitScope(scope), billedInr: keyCost.get(scope)?.inr ?? null, ...(keyUsage.get(scope) ?? tokens()), quiz: quizOf(scope) }))
          .sort((a, b) => (b.billedInr ?? b.listInr) - (a.billedInr ?? a.listInr))
          .slice(0, 20),
      }

      // --- Gemini (the tutor's project): billed, or not billed (free tier), or unknown
      const geminiRows = google.filter((r) => r.scope === TUTOR_GEMINI_PROJECT && inWindow(r))
      const exportHasData = !!status.google.earliestDay
      const gemini = {
        project: TUTOR_GEMINI_PROJECT,
        status: geminiRows.length ? 'billed' : exportHasData ? 'not_billed' : 'not_connected',
        netInr: geminiRows.length ? geminiRows.reduce((s, r) => s + (r.costUsd + r.creditsUsd) * usd, 0) : null,
      }

      // --- AI tutor: what it computes from usage × price NEXT TO what was billed (never added)
      const geminiNetByMonth = (month: string) =>
        google.filter((r) => r.scope === TUTOR_GEMINI_PROJECT && r.day.startsWith(month)).reduce((s, r) => s + (r.costUsd + r.creditsUsd) * usd, 0)
      const tutorComparison = months
        .slice(-3)
        .flatMap((month) =>
          ['google', 'sarvam', 'livekit'].map((provider) => {
            const computed = recon.find((r) => r.month === month && r.provider === provider)
            const invoice = invoices.find((i) => i.month === month && i.provider === provider)
            let billed: { inr: number | null; status: string; source: string }
            if (provider === 'google') {
              billed = googleMonths.has(month)
                ? geminiNetByMonth(month) || google.some((r) => r.scope === TUTOR_GEMINI_PROJECT && r.day.startsWith(month))
                  ? { inr: geminiNetByMonth(month), status: 'billed', source: `GCP export, project ${TUTOR_GEMINI_PROJECT}` }
                  : { inr: null, status: 'not_billed', source: 'not billed (free tier project)' }
                : invoice
                  ? { inr: n(invoice.amount_inr), status: 'billed', source: 'Finance’s bill' }
                  : { inr: null, status: exportHasData ? 'no_export' : 'not_connected', source: exportHasData ? 'export has no rows this month' : 'billing export not connected' }
            } else {
              billed = invoice ? { inr: n(invoice.amount_inr), status: 'billed', source: 'Finance’s bill' } : { inr: null, status: 'not_entered', source: 'no bill entered (Sarvam/LiveKit have no billing API)' }
            }
            return {
              month,
              provider,
              label: provider === 'google' ? 'Google Gemini' : (PROVIDER_LABEL[provider] ?? provider),
              computedInr: computed?.computedInr ?? 0,
              computedEstimatedInr: computed?.estimatedInr ?? 0,
              billed,
            }
          })
        )
        .filter((r) => r.computedInr > 0 || r.billed.inr !== null)

      // --- freshness per source
      const latest = (list: ProviderDbRow[]) => list.reduce<string | null>((m, r) => (m === null || r.day > m ? r.day : m), null)
      const lastInvoice = invoices.reduce<{ month: string; at: unknown } | null>((m, i) => (m === null || i.month > m.month ? { month: i.month, at: i.updated_at } : m), null)
      const sources = {
        openaiUsage: { connected: status.openai.connected, missing: status.openai.missing, lastRun: status.openai.lastRun, latestDay: latest(usage), demo: !!status.openai.lastRun?.demo },
        openaiCosts: { connected: status.openai.connected, latestDay: latest(costs), byKey: status.openai.lastRun?.costsByKey ?? null },
        gcp: { connected: status.google.connected, missing: status.google.missing, problem: status.google.problem, lastRun: status.google.lastRun, latestDay: latest(google), demo: !!status.google.lastRun?.demo },
        manual: { latestMonth: lastInvoice?.month ?? null, updatedAt: lastInvoice?.at ?? null, entries: invoices.length },
      }

      const window = {
        openaiInr: sumSeries((d) => d.openaiInr),
        openaiUsageDays: series.filter((d) => d.openaiBasis === 'usage').length,
        googleGrossInr: sumSeries((d) => d.googleGrossInr),
        googleCreditsInr: sumSeries((d) => d.googleCreditsInr),
        googleNetInr: sumSeries((d) => d.googleNetInr),
        totalInr: sumSeries((d) => d.totalInr),
        split: { quizzes: sumSeries((d) => d.quizzesInr), tutor: sumSeries((d) => d.tutorInr), other: sumSeries((d) => d.otherInr) },
        quizParts: { speechInr: sumSeries((d) => d.speechInr), markingInr: sumSeries((d) => d.markingInr) },
        incompleteDays: series.filter((d) => !d.complete).map((d) => d.day),
      }

      const anyData = rows.length > 0 || invoices.length > 0
      return {
        days,
        usdToInr: usd,
        attribution: status.attribution,
        empty: anyData ? null : status.openai.connected || status.google.connected ? 'no_data_yet' : 'not_connected',
        sources,
        window,
        series,
        months: monthRows,
        gcp,
        openai,
        gemini,
        tutorComparison,
        tutorComputedWindowInr: tutorCost.exactInr + tutorCost.estimatedInr,
      }
    })
  }
}

export default new FullBillService()
