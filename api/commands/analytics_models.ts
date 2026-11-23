import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * The nightly SQL models (MUL-151, docs/PRODUCT_ANALYTICS.md §3): sessions, screens per day,
 * features per day, ordered funnels, weekly retention and health, from events_raw and the
 * facts. Idempotent per day: re-running a date rebuilds its partitions.
 *
 * Nightly, after analytics:export-facts, e.g. 03:00 IST (models yesterday, IST):
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace analytics:models
 * Backfill (oldest day first, so the identity links and first-seen dates build up in order):
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace analytics:models --from 2026-12-01 --to 2026-12-14
 * Review the SQL without BigQuery: --print
 */
export default class AnalyticsModels extends BaseCommand {
  static commandName = 'analytics:models'
  static description = 'Build the product analytics models in BigQuery for an IST day (default: yesterday)'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'The IST day to model, YYYY-MM-DD (default: yesterday)' })
  declare date?: string

  @flags.string({ description: 'Backfill from this IST day (with --to)' })
  declare from?: string

  @flags.string({ description: 'Backfill up to this IST day (default: yesterday)' })
  declare to?: string

  @flags.string({ description: 'Only these models, comma separated (identity_links, user_firsts, sessions, screen_daily, feature_daily, health_daily, funnel_steps, retention_weekly)' })
  declare only?: string

  @flags.boolean({ description: 'Print the SQL and exit (no BigQuery needed)' })
  declare print?: boolean

  async run() {
    const { MODEL_STEPS, runModels, yesterdayIst } = await import('#services/product_analytics/models')
    const { openWarehouse, Refs } = await import('#services/product_analytics/warehouse')
    const { istDayLabel } = await import('#helpers/ist')
    const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

    const only = (this.only ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const known = MODEL_STEPS.map((s) => s.step as string)
    const unknown = only.filter((s) => !known.includes(s))
    if (unknown.length) {
      this.logger.error(`Unknown model(s): ${unknown.join(', ')}. Models: ${known.join(', ')}`)
      this.exitCode = 1
      return
    }

    const yesterday = yesterdayIst()
    const from = this.from ?? this.date ?? yesterday
    const to = this.from ? (this.to ?? yesterday) : (this.date ?? yesterday)
    if (!DAY.test(from) || !DAY.test(to) || from > to || to > yesterday) {
      this.logger.error(`--date/--from/--to must be YYYY-MM-DD, in order, and no later than yesterday (${yesterday} IST): today's events are still arriving`)
      this.exitCode = 1
      return
    }

    const warehouse = await openWarehouse()
    if (this.print) {
      const refs = warehouse.refs ?? new Refs('your-gcp-project', warehouse.config.dataset)
      for (const s of MODEL_STEPS.filter((m) => !only.length || only.includes(m.step))) {
        this.logger.log(`-- ${s.step} → ${s.table} (@run_date = '${from}')\n${s.sql(refs)};\n`)
      }
      return
    }
    if (!warehouse.client || !warehouse.refs) {
      const why = warehouse.config.problem ?? `missing ${warehouse.config.missing.join(', ')}`
      this.logger.info(`Product analytics is not connected (${why}): nothing modelled.`)
      return
    }

    const days: string[] = []
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) days.push(istDayLabel(Math.round(t / 86_400_000)))
    for (const date of days) {
      const result = await runModels({ date, warehouse: warehouse.client, refs: warehouse.refs, only: only as never, log: (line) => this.logger.info(line) })
      if (result.check) this.logger.info(`${date}: ${result.check.events} events → ${result.check.sessions} sessions, ${result.check.screens} screens, ${result.check.features} features`)
      if (result.warning) (result.ok ? this.logger.warning : this.logger.error).call(this.logger, result.warning)
      if (!result.ok) {
        this.exitCode = 1
        return
      }
    }
    this.logger.success(`Models built for ${days.length === 1 ? days[0] : `${from} → ${to}`}.`)
  }
}
