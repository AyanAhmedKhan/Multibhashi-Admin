import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Computes the frozen daily quiz metrics (console_quiz_daily_metrics, docs/QUIZ_OBSERVABILITY.md
 * §7) from the answer tables, the app's quiz events and the synced provider bills. Settled days
 * become final and are never rewritten by a later run, so a fix's "before" stays put.
 *
 * Daily, after the provider sync (03:15 IST), e.g. 03:45 IST:
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace quiz:daily-metrics
 * Once, to fill the baseline in:
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace quiz:daily-metrics --backfill
 */
export default class QuizDailyMetrics extends BaseCommand {
  static commandName = 'quiz:daily-metrics'
  static description = 'Compute and store the daily quiz metrics (answers, attempts, app events, cost) for before/after comparisons'
  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'IST days back, today included (1–120); ignored with --from', default: 7 })
  declare days: number

  @flags.string({ description: 'First IST day, YYYY-MM-DD' })
  declare from?: string

  @flags.string({ description: 'Last IST day, YYYY-MM-DD (default: today)' })
  declare to?: string

  @flags.boolean({ description: 'From the baseline start (2026-09-01) to today' })
  declare backfill?: boolean

  @flags.boolean({ description: 'Also rewrite final rows (only after fixing a definition bug)' })
  declare force?: boolean

  async run() {
    const { istDayLabel, istDayOf } = await import('#helpers/ist')
    const { default: store, BACKFILL_FROM } = await import('#services/analytics/quiz_metrics_store')
    const label = /^\d{4}-\d{2}-\d{2}$/
    const today = istDayLabel(istDayOf(Date.now()))
    const to = this.to ?? today
    const days = Math.min(120, Math.max(1, this.days ?? 7))
    const from = this.backfill ? BACKFILL_FROM : (this.from ?? istDayLabel(istDayOf(Date.parse(`${to}T12:00:00+05:30`)) - days + 1))
    if (!label.test(from) || !label.test(to) || from > to) {
      this.logger.error(`--from ${from} / --to ${to}: expected YYYY-MM-DD, from on or before to`)
      this.exitCode = 1
      return
    }
    if (to > today) {
      this.logger.error(`--to ${to} is in the future (today is ${today} IST)`)
      this.exitCode = 1
      return
    }
    const started = Date.now()
    try {
      const result = await store.run({ from, to, force: !!this.force })
      for (const c of result.chunks) {
        this.logger.info(`${c.from} → ${c.to}: ${c.answers} answers, ${c.attempts} attempts, ${c.events} events → ${c.rows} rows${c.kept ? `, ${c.kept} final kept` : ''}`)
      }
      this.logger.success(
        `quiz metrics v${result.definitionVersion}, ${from} → ${to}: ${result.written} rows written, ${result.keptFinal} final rows kept (${Math.round((Date.now() - started) / 1000)} s)`
      )
    } catch (error) {
      this.logger.error(`quiz metrics failed: ${(error as Error).message}`)
      this.exitCode = 1
    }
  }
}
