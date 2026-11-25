import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Old vs new analytics, day by day (MUL-155, docs/ANALYTICS_CONSOLIDATION.md): the activity
 * pipeline in MySQL (student_sessions, student_activity_events) against the product events in
 * BigQuery, for the concepts both carry. Read-only. It retires nothing: it says whether the
 * gating concepts have matched for 14 days in a row, the condition for retiring the old writes.
 *
 *   node ace analytics:parity                 # the last 14 IST days up to yesterday
 *   node ace analytics:parity --days 28 --verbose
 *   node ace analytics:parity --json          # for a report or a dashboard
 */
export default class AnalyticsParity extends BaseCommand {
  static commandName = 'analytics:parity'
  static description = 'Compare daily counts of the new product events with student_activity_events / student_sessions (retires nothing)'
  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'IST days up to yesterday (default 14)' })
  declare days?: number

  @flags.string({ description: 'Last IST day, YYYY-MM-DD (default: yesterday)' })
  declare to?: string

  @flags.boolean({ description: 'Print every day, not only the summary' })
  declare verbose?: boolean

  @flags.boolean({ description: 'Print JSON' })
  declare json?: boolean

  async run() {
    const { istDayLabel, istDayOf } = await import('#helpers/ist')
    const { REQUIRED_STREAK, compare, readBigQuery, readMysql } = await import('#services/product_analytics/parity')
    const { openWarehouse } = await import('#services/product_analytics/warehouse')

    const yesterday = istDayLabel(istDayOf(Date.now()) - 1)
    const to = this.to ?? yesterday
    const days = Math.min(90, Math.max(1, Math.floor(this.days ?? 14)))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || to > yesterday) {
      this.logger.error(`--to must be YYYY-MM-DD, no later than yesterday (${yesterday} IST)`)
      this.exitCode = 1
      return
    }
    const from = istDayLabel(Math.round(Date.parse(`${to}T00:00:00Z`) / 86_400_000) - days + 1)
    const warehouse = await openWarehouse()
    if (!warehouse.client || !warehouse.refs) {
      const why = warehouse.config.problem ?? `missing ${warehouse.config.missing.join(', ')}`
      this.logger.info(`Product analytics is not connected (${why}): nothing to compare yet.`)
      return
    }
    const range = { from, to }
    const [mysql, bigquery] = await Promise.all([readMysql(range), readBigQuery(range, warehouse.client, warehouse.refs)])
    const result = compare(mysql, bigquery, range)
    if (this.json) {
      this.logger.log(JSON.stringify({ range, ...result }, null, 2))
      return
    }
    this.logger.log(`Parity ${from} → ${to} (IST): old pipeline (MySQL) vs product events (BigQuery)\n`)
    const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
    this.logger.log(`${pad('concept', 30)} ${pad('gates', 6)} ${pad('days ok', 9)} ${pad('streak', 7)} ${pad('max diff', 9)} tolerance`)
    for (const c of result.concepts) {
      this.logger.log(
        `${pad(c.label, 30)} ${pad(c.gates ? 'yes' : '', 6)} ${pad(`${c.within}/${c.compared}`, 9)} ${pad(String(c.streak), 7)} ${pad(c.maxAbsDiffPct === null ? '—' : `${c.maxAbsDiffPct}%`, 9)} ±${c.tolerance}%${c.note ? `  (${c.note})` : ''}`
      )
      if (this.verbose) for (const d of c.days) this.logger.log(`    ${d.day}  mysql ${d.mysql}  bigquery ${d.bigquery}  ${d.diffPct === null ? 'n/a' : `${d.diffPct > 0 ? '+' : ''}${d.diffPct}%`}${d.ok ? '' : '  ✗'}`)
    }
    this.logger.log(
      result.ready
        ? `\nEvery gating concept has matched for ${REQUIRED_STREAK}+ days in a row. Retiring the old writes still needs the other conditions in docs/ANALYTICS_CONSOLIDATION.md, and nothing is retired by this command.`
        : `\nNot ready to retire the old writes: ${result.blocking.join(', ')} ${result.blocking.length === 1 ? 'has' : 'have'} not matched for ${REQUIRED_STREAK} days in a row.`
    )
  }
}
