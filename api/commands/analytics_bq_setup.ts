import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * The product analytics warehouse DDL (MUL-148, docs/PRODUCT_ANALYTICS.md): the dataset
 * (asia-south1), events_raw / events_dev (contract §5.4: partitioned by event_date, 395 and 30
 * day partition expiry, clustered by event_name and user_id), the facts and the model tables.
 * By default it only prints the plan and the SQL; --apply runs it with the configured service
 * account. Every statement is idempotent, so it is safe to re-run after each deploy:
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace analytics:bq-setup
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace analytics:bq-setup --apply
 */
export default class AnalyticsBqSetup extends BaseCommand {
  static commandName = 'analytics:bq-setup'
  static description = 'Print (default) or apply (--apply) the product analytics BigQuery DDL: dataset, events, facts, models'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Create or update the objects in BigQuery (needs GCP_ANALYTICS_* set)' })
  declare apply?: boolean

  @flags.boolean({ description: 'Print the plan only, without the SQL' })
  declare planOnly?: boolean

  async run() {
    const { readWarehouseConfig } = await import('#services/product_analytics/config')
    const { bqSetup } = await import('#services/product_analytics/ddl')
    const config = await readWarehouseConfig()
    try {
      const result = await bqSetup({ config, apply: !!this.apply, printSql: !this.planOnly, log: (line) => this.logger.log(line) })
      if (this.apply) this.logger.success(`Applied ${result.applied} statements to ${config.dataset} (${config.location}).`)
    } catch (error) {
      this.logger.error(`analytics:bq-setup failed: ${String((error as Error).message ?? error).slice(0, 300)}`)
      this.exitCode = 1
    }
  }
}
