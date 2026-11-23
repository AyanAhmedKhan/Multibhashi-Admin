import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Business facts → BigQuery (MUL-149, docs/PRODUCT_ANALYTICS.md §2): verified learners,
 * bookings, captured payments, class attendance, quiz attempts, AI tutor classes and the
 * identity link, read from the MySQL `analytics` connection (the read replica). Idempotent per
 * date range: each table's rows in the range are replaced in one transaction.
 *
 * Nightly, before analytics:models, e.g. 02:30 IST:
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace analytics:export-facts
 * Once, to fill the history in (off-peak):
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace analytics:export-facts --full
 * Locally, against the Docker MySQL, without BigQuery: --dry-run (reads and counts only).
 */
export default class AnalyticsExportFacts extends BaseCommand {
  static commandName = 'analytics:export-facts'
  static description = 'Export the business facts (users, bookings, payments, attendance, quizzes, tutor, identities) from MySQL to BigQuery'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'First IST day, YYYY-MM-DD' })
  declare from?: string

  @flags.string({ description: 'Last IST day, YYYY-MM-DD (default: today)' })
  declare to?: string

  @flags.number({ description: 'IST days back, today included, when --from is not given (default 7)' })
  declare days?: number

  @flags.boolean({ description: 'Replace whole tables with everything in MySQL (first run, or after a definition fix)' })
  declare full?: boolean

  @flags.string({ description: 'Only these tables, comma separated (e.g. fact_users,identities)' })
  declare only?: string

  @flags.boolean({ description: 'Read and count the rows, load nothing (no BigQuery needed)' })
  declare dryRun?: boolean

  async run() {
    const { istDayLabel, istDayOf } = await import('#helpers/ist')
    const { exportFacts, resolveRange } = await import('#services/product_analytics/facts')
    const { MysqlFactSource } = await import('#services/product_analytics/facts_mysql')
    const { FACT_TABLES } = await import('#services/product_analytics/ddl')
    const { openWarehouse } = await import('#services/product_analytics/warehouse')

    let range
    try {
      range = resolveRange({ from: this.from, to: this.to, days: this.days, full: this.full }, istDayLabel(istDayOf(Date.now())))
    } catch (error) {
      this.logger.error((error as Error).message)
      this.exitCode = 1
      return
    }
    const only = (this.only ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const unknown = only.filter((t) => !(FACT_TABLES as readonly string[]).includes(t))
    if (unknown.length) {
      this.logger.error(`Unknown table(s): ${unknown.join(', ')}. Tables: ${FACT_TABLES.join(', ')}`)
      this.exitCode = 1
      return
    }

    const warehouse = this.dryRun ? null : await openWarehouse()
    if (warehouse && !warehouse.client) {
      const why = warehouse.config.problem ?? `missing ${warehouse.config.missing.join(', ')}`
      this.logger.info(`Product analytics is not connected (${why}): nothing exported.`)
      return
    }
    this.logger.info(range.full ? 'Exporting everything (--full).' : `Exporting ${range.from} → ${range.to} (IST).`)
    const started = Date.now()
    const results = await exportFacts({
      range,
      tables: only as never,
      source: new MysqlFactSource(),
      warehouse: warehouse?.client ?? undefined,
      refs: warehouse?.refs ?? undefined,
      log: (line) => this.logger.info(line),
    })
    const failed = results.filter((r) => r.status === 'failed')
    const total = results.reduce((s, r) => s + r.rows, 0)
    if (failed.length) {
      this.logger.error(`${failed.length} table(s) failed: ${failed.map((f) => f.table).join(', ')}`)
      this.exitCode = 1
    } else {
      this.logger.success(`${this.dryRun ? 'Counted' : 'Exported'} ${total} rows in ${results.length} tables (${Math.round((Date.now() - started) / 1000)} s).`)
    }
  }
}
