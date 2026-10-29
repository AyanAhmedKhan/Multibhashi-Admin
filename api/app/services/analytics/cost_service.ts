import db from '@adonisjs/lucid/services/db'
import ApiException from '#exceptions/api_exception'
import auditService from '#services/audit_service'
import { istDayLabel, istDayOf, istDayStart } from '#helpers/ist'
import {
  ENGINES,
  UNIT_LABEL,
  baseIdOf,
  costModelStore,
  estimateEngine,
  istToday,
  modelStatus,
  perMinuteInr,
  priceFor,
  unitPriceInr,
  withLatestPrices,
  type CostModel,
} from '#services/analytics/cost_model'
import type { Actor } from '#services/actor'

/**
 * AI cost. Classes with rows in `ai_tutor_session_usage` (docs/AI_USAGE_SPEC.md) are
 * priced exactly: recorded quantity × rate-card price. Classes without rows (before usage
 * recording, or a lost save) are estimated from minutes × the per-minute assumptions, and
 * every figure says how much of it is exact. Both use the prices in force on the class's day.
 */

const USAGE = 'ai_tutor_session_usage'
const PAID_SOURCES = ['single_purchase', 'extend', 'package', 'purchase']
const PROVIDERS = ['sarvam', 'google', 'livekit']
const CACHE_MS = 120_000

const conn = () => db.connection('analytics')
const n = (v: unknown) => Number(v ?? 0)
const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits

interface UsageRow {
  chat: number
  day: string
  engine: string
  language: string | null
  kind: string
  provider: string
  model: string
  unit: string
  quantity: number
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

class CostService {
  #cache = new Map<string, { at: number; value: unknown }>()
  #usageTable: { at: number; exists: boolean } | null = null

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T
    const value = await fn()
    this.#cache.set(key, { at: Date.now(), value })
    return value
  }

  clearCache() {
    this.#cache.clear()
    this.#usageTable = null
  }

  /** The usage table is created by the tutor API's migration; until then everything is estimated. */
  async usageRecorded() {
    if (this.#usageTable && Date.now() - this.#usageTable.at < 60_000) return this.#usageTable.exists
    const rows = await conn()
      .from('information_schema.tables')
      .whereRaw('table_schema = DATABASE()')
      .where('table_name', USAGE)
      .count('* as total')
    const exists = n(rows[0]?.total) > 0
    this.#usageTable = { at: Date.now(), exists }
    return exists
  }

  private price(model: CostModel, row: Pick<UsageRow, 'provider' | 'model' | 'unit' | 'quantity' | 'day'>) {
    const line = priceFor(model, row.provider, row.model, row.unit, row.day)
    return { line, inr: line ? row.quantity * unitPriceInr(line, model.usdToInr) : 0 }
  }

  /** Per-minute estimates per day (a price can change on a date). */
  private ratesByDay(model: CostModel) {
    const memo = new Map<string, ReturnType<typeof perMinuteInr>>()
    return (day: string) => {
      if (!memo.has(day)) memo.set(day, perMinuteInr(model, day))
      return memo.get(day)!
    }
  }

  cost(days: number) {
    return this.cached(`cost:${days}`, async () => {
      const today = istDayOf(Date.now())
      const firstDay = today - days + 1
      const since = new Date(istDayStart(firstDay))
      const model = await costModelStore.get()
      const rates = perMinuteInr(model)
      const ratesOn = this.ratesByDay(model)
      const recorded = await this.usageRecorded()

      const [classes, sold, usage] = await Promise.all([
        conn()
          .from('ai_tutor_chats as c')
          .leftJoin('ai_tutor_session_summaries as s', 's.ai_tutor_chat_id', 'c.id')
          .where('c.created_at', '>=', since)
          .select('c.id', 'c.user_id', 'c.time_spent', 'c.lesson_topic', 's.language', conn().raw('DATE_FORMAT(c.created_at, "%Y-%m-%d") as day')),
        conn().from('ai_tutor_time_logs').where('created_at', '>=', since).whereIn('source', PAID_SOURCES).sum('minutes_added as minutes').first(),
        recorded
          ? conn()
              .from(`${USAGE} as u`)
              .join('ai_tutor_chats as c', 'c.id', 'u.ai_tutor_chat_id')
              .where('c.created_at', '>=', since)
              .groupBy('u.ai_tutor_chat_id', 'u.engine', 'u.language', 'u.kind', 'u.provider', 'u.model', 'u.unit', 'day')
              .select('u.ai_tutor_chat_id as chat', 'u.engine', 'u.language', 'u.kind', 'u.provider', 'u.model', 'u.unit', conn().raw('DATE_FORMAT(c.created_at, "%Y-%m-%d") as day'))
              .sum('u.quantity as quantity')
          : Promise.resolve([]),
      ])

      const rows: UsageRow[] = usage.map((u: Record<string, unknown>) => ({
        chat: n(u.chat),
        day: String(u.day),
        engine: String(u.engine),
        language: (u.language as string) ?? null,
        kind: String(u.kind),
        provider: String(u.provider),
        model: String(u.model ?? ''),
        unit: String(u.unit),
        quantity: n(u.quantity),
      }))

      // --- exact: price every recorded row
      const perChat = new Map<number, { inr: number; engine: string }>()
      const lines = new Map<string, { label: string; provider: string; model: string; unit: string; quantity: number; exactInr: number; estimatedInr: number; priced: boolean }>()
      const engineQty = new Map<string, number>() // `${engine}|${priceId}` → quantity (for calibration)
      for (const r of rows) {
        const { line, inr } = this.price(model, r)
        const key = line ? line.id : `unpriced:${r.provider}|${r.model}|${r.unit}`
        const cur = lines.get(key) ?? {
          label: line?.label ?? `${r.provider} ${r.model || ''} ${UNIT_LABEL[r.unit] ?? r.unit}`.replace(/\s+/g, ' '),
          provider: r.provider,
          model: line?.model ?? r.model,
          unit: r.unit,
          quantity: 0,
          exactInr: 0,
          estimatedInr: 0,
          priced: !!line,
        }
        cur.quantity += r.quantity
        cur.exactInr += inr
        lines.set(key, cur)
        const chat = perChat.get(r.chat) ?? { inr: 0, engine: r.engine }
        chat.inr += inr
        perChat.set(r.chat, chat)
        if (line) {
          // Calibration compares with the estimate, which names the first line of a key.
          const base = `${r.engine}|${baseIdOf(model, line)}`
          engineQty.set(base, (engineQty.get(base) ?? 0) + r.quantity)
        }
      }

      // --- estimate the classes without usage rows
      const byEngine = new Map<string, { classes: number; minutes: number; exactInr: number; estimatedInr: number; exactMinutes: number }>()
      const engineOf = (e: string) => {
        const cur = byEngine.get(e) ?? { classes: 0, minutes: 0, exactInr: 0, estimatedInr: 0, exactMinutes: 0 }
        byEngine.set(e, cur)
        return cur
      }
      const dayMap = new Map<string, { exact: number; estimated: number }>()
      let minutes = 0
      let coveredMinutes = 0
      let coveredClasses = 0
      let estimatedInr = 0
      const learners = new Set<number>()
      const top: { id: number; userId: number; topic: string | null; engine: string; minutes: number; costInr: number }[] = []
      for (const c of classes) {
        const spent = n(c.time_spent)
        minutes += spent
        learners.add(n(c.user_id))
        const day = dayMap.get(c.day) ?? { exact: 0, estimated: 0 }
        dayMap.set(c.day, day)
        const exact = perChat.get(n(c.id))
        if (exact) {
          coveredClasses++
          coveredMinutes += spent
          day.exact += exact.inr
          const e = engineOf(exact.engine)
          e.classes++
          e.minutes += spent
          e.exactMinutes += spent
          e.exactInr += exact.inr
          top.push({ id: n(c.id), userId: n(c.user_id), topic: c.lesson_topic, engine: exact.engine, minutes: spent, costInr: exact.inr })
        } else {
          const engine = estimateEngine(c.language, model.defaultEngine)
          const dayRates = ratesOn(String(c.day))[engine]
          const inr = spent * dayRates.total
          estimatedInr += inr
          day.estimated += inr
          const e = engineOf(engine)
          e.classes++
          e.minutes += spent
          e.estimatedInr += inr
          for (const part of dayRates.parts) {
            const line = model.prices.find((p) => p.id === part.lineId)
            if (!line) continue
            const cur = lines.get(line.id) ?? { label: line.label, provider: line.provider, model: line.model, unit: line.unit, quantity: 0, exactInr: 0, estimatedInr: 0, priced: true }
            cur.estimatedInr += spent * part.inr
            lines.set(line.id, cur)
          }
        }
      }
      const exactInr = [...perChat.values()].reduce((s, c) => s + c.inr, 0)
      const fixedMonthly = model.fixedMonthly.reduce((s, f) => s + f.amountInr, 0)
      const fixedInr = (fixedMonthly / 30) * days
      const totalInr = exactInr + estimatedInr + fixedInr
      const soldMinutes = n(sold?.minutes)
      const revenueInr = soldMinutes * model.pricePerPaidMinuteInr
      const perMinute = minutes ? (exactInr + estimatedInr + fixedInr) / minutes : 0
      const exactCosts = top.map((t) => t.costInr).sort((a, b) => a - b)

      // --- calibration: measured usage per class minute vs the assumption
      const calibration = ENGINES.flatMap((engine) => {
        const basis = byEngine.get(engine)?.exactMinutes ?? 0
        if (!basis) return []
        return model.prices
          .filter((line) => engineQty.has(`${engine}|${line.id}`))
          .map((line) => ({
            engine,
            priceId: line.id,
            label: line.label,
            unit: line.unit,
            assumed: model.assumptions[engine].usage.find((u) => u.priceId === line.id)?.perMinute ?? 0,
            measured: round((engineQty.get(`${engine}|${line.id}`) ?? 0) / basis, 1),
            basisMinutes: basis,
          }))
      })

      return {
        recorded,
        days,
        classes: classes.length,
        minutes,
        coverage: {
          classes: coveredClasses,
          minutes: coveredMinutes,
          minutesShare: minutes ? round((coveredMinutes / minutes) * 100, 1) : 0,
        },
        exactInr,
        estimatedInr,
        fixedInr,
        totalInr,
        perMinuteInr: perMinute,
        exactPerMinuteInr: coveredMinutes ? exactInr / coveredMinutes : null,
        perClassInr: classes.length ? totalInr / classes.length : 0,
        perLearnerInr: learners.size ? totalInr / learners.size : 0,
        perClass: { avg: exactCosts.length ? exactInr / exactCosts.length : null, median: percentile(exactCosts, 50), p90: percentile(exactCosts, 90) },
        soldMinutes,
        revenueInr,
        marginInr: revenueInr - soldMinutes * perMinute,
        marginShare: revenueInr ? round(((revenueInr - soldMinutes * perMinute) / revenueInr) * 100, 1) : null,
        monthlyRunRateInr: ((exactInr + estimatedInr) / days) * 30 + fixedMonthly,
        byProvider: [...lines.entries()]
          .map(([id, l]) => ({ id, ...l, totalInr: l.exactInr + l.estimatedInr, unitLabel: UNIT_LABEL[l.unit] ?? l.unit }))
          .sort((a, b) => b.totalInr - a.totalInr),
        engines: ENGINES.map((engine) => {
          const e = byEngine.get(engine) ?? { classes: 0, minutes: 0, exactInr: 0, estimatedInr: 0, exactMinutes: 0 }
          return {
            engine,
            label: model.assumptions[engine].label,
            ...e,
            measuredPerMinuteInr: e.exactMinutes ? e.exactInr / e.exactMinutes : null,
            assumedPerMinuteInr: rates[engine].total,
            parts: rates[engine].parts,
          }
        }),
        topClasses: top.sort((a, b) => b.costInr - a.costInr).slice(0, 10),
        calibration,
        // Official prices re-checked after the saved price list: the page offers to apply them.
        modelStatus: modelStatus(model),
        latestModel: modelStatus(model).outdated ? withLatestPrices(model) : null,
        series: Array.from({ length: days }, (_, i) => {
          const label = istDayLabel(firstDay + i)
          const d = dayMap.get(label) ?? { exact: 0, estimated: 0 }
          return { day: label, exactInr: round(d.exact), estimatedInr: round(d.estimated), costInr: round(d.exact + d.estimated) }
        }),
        model,
      }
    })
  }

  /** The usage and cost of one class (all its jobs). */
  async classCost(chatId: number) {
    const model = await costModelStore.get()
    if (!(await this.usageRecorded())) return { recorded: false, items: [], totalInr: 0, jobs: 0 }
    const chat = await conn().from('ai_tutor_chats').where('id', chatId).select(conn().raw('DATE_FORMAT(created_at, "%Y-%m-%d") as day')).first()
    const day = chat?.day ? String(chat.day) : istToday()
    const [rows, jobs] = await Promise.all([
      conn()
        .from(USAGE)
        .where('ai_tutor_chat_id', chatId)
        .groupBy('engine', 'kind', 'provider', 'model', 'unit')
        .select('engine', 'kind', 'provider', 'model', 'unit')
        .sum('quantity as quantity'),
      conn().from(USAGE).where('ai_tutor_chat_id', chatId).countDistinct('job_id as jobs').first(),
    ])
    const items = rows.map((r: Record<string, unknown>) => {
      const row = { provider: String(r.provider), model: String(r.model ?? ''), unit: String(r.unit), quantity: n(r.quantity), day }
      const { line, inr } = this.price(model, row)
      return { ...row, engine: r.engine, kind: r.kind, label: line?.label ?? null, unitLabel: UNIT_LABEL[row.unit] ?? row.unit, costInr: inr, priced: !!line }
    })
    return { recorded: true, items, totalInr: items.reduce((s, i) => s + i.costInr, 0), jobs: n(jobs?.jobs) }
  }

  /** Computed cost per provider per IST month vs what Finance entered from the bills. */
  async reconciliation(months: number) {
    const model = await costModelStore.get()
    const ratesOn = this.ratesByDay(model)
    const now = new Date(Date.now() + 19_800_000)
    const monthList = Array.from({ length: months }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      return d.toISOString().slice(0, 7)
    })
    const from = new Date(`${monthList[monthList.length - 1]}-01T00:00:00+05:30`)
    const recorded = await this.usageRecorded()
    const [usage, uncovered, invoices] = await Promise.all([
      recorded
        ? conn()
            .from(USAGE)
            .where('created_at', '>=', from)
            .groupByRaw('DATE_FORMAT(created_at, "%Y-%m-%d"), provider, model, unit')
            .select(conn().raw('DATE_FORMAT(created_at, "%Y-%m-%d") as day'), 'provider', 'model', 'unit')
            .sum('quantity as quantity')
        : Promise.resolve([]),
      conn()
        .from('ai_tutor_chats as c')
        .leftJoin('ai_tutor_session_summaries as s', 's.ai_tutor_chat_id', 'c.id')
        .where('c.created_at', '>=', from)
        .if(recorded, (q) => q.whereNotExists((sub) => sub.from(USAGE).whereRaw(`${USAGE}.ai_tutor_chat_id = c.id`)))
        .groupByRaw('DATE_FORMAT(c.created_at, "%Y-%m-%d"), s.language')
        .select(conn().raw('DATE_FORMAT(c.created_at, "%Y-%m-%d") as day'), 's.language')
        .sum('c.time_spent as minutes'),
      db.from('console_cost_invoices').where('month', '>=', monthList[monthList.length - 1]).select('month', 'provider', 'amount_inr', 'note'),
    ])
    const cells = new Map<string, { exactInr: number; estimatedInr: number }>()
    const cell = (month: string, provider: string) => {
      const key = `${month}|${provider}`
      const cur = cells.get(key) ?? { exactInr: 0, estimatedInr: 0 }
      cells.set(key, cur)
      return cur
    }
    for (const u of usage) {
      const day = String(u.day)
      const { inr } = this.price(model, { provider: u.provider, model: u.model ?? '', unit: u.unit, quantity: n(u.quantity), day })
      cell(day.slice(0, 7), PROVIDERS.includes(u.provider) ? u.provider : 'other').exactInr += inr
    }
    for (const c of uncovered) {
      const day = String(c.day)
      const engine = estimateEngine(c.language, model.defaultEngine)
      for (const part of ratesOn(day)[engine].parts) {
        const line = model.prices.find((p) => p.id === part.lineId)
        if (line) cell(day.slice(0, 7), PROVIDERS.includes(line.provider) ? line.provider : 'other').estimatedInr += n(c.minutes) * part.inr
      }
    }
    return monthList.flatMap((month) =>
      [...PROVIDERS, 'other'].map((provider) => {
        const computed = cells.get(`${month}|${provider}`) ?? { exactInr: 0, estimatedInr: 0 }
        const bill = invoices.find((i) => i.month === month && i.provider === provider)
        const computedInr = computed.exactInr + computed.estimatedInr
        const billedInr = bill ? n(bill.amount_inr) : null
        return {
          month,
          provider,
          ...computed,
          computedInr,
          billedInr,
          note: bill?.note ?? null,
          variancePct: billedInr && computedInr ? round(((computedInr - billedInr) / billedInr) * 100, 1) : null,
        }
      })
    ).filter((r) => r.computedInr > 0 || r.billedInr !== null)
  }

  async saveInvoice(actor: Actor, input: { month: string; provider: string; amountInr: number; note?: string | null }, reason: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new ApiException(422, 'Month must be YYYY-MM')
    if (![...PROVIDERS, 'other'].includes(input.provider)) throw new ApiException(422, 'Unknown provider')
    await db.transaction(async (trx) => {
      const before = await trx.from('console_cost_invoices').where('month', input.month).where('provider', input.provider).first()
      await trx
        .insertQuery()
        .table('console_cost_invoices')
        .insert({
          month: input.month,
          provider: input.provider,
          amount_inr: input.amountInr,
          note: input.note?.slice(0, 255) ?? null,
          entered_by: actor.user.id,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .knexQuery.onConflict(['month', 'provider'])
        .merge(['amount_inr', 'note', 'entered_by', 'updated_at'])
      await auditService.record(
        {
          actor,
          action: 'analytics.invoice.saved',
          targetType: 'invoice',
          targetId: `${input.month}:${input.provider}`,
          reason,
          metadata: { before: before ? Number(before.amount_inr) : null, after: input.amountInr },
        },
        trx
      )
    })
  }
}

export default new CostService()
