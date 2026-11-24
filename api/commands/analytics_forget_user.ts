import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Deletes one learner from product analytics (MUL-153, docs/PRODUCT_ANALYTICS.md §6): their
 * events in events_raw and events_dev (and their devices' anonymous events), facts, identity
 * rows and person-level model rows. Logged in console_analytics_forgotten (the facts export
 * then keeps them out) and in the audit log.
 *
 *   node ace analytics:forget-user 64ab0c… --reason "MUL-xyz: account deletion request"
 *   node ace analytics:forget-user 4567 --dry-run      # counts only, deletes nothing
 * Daily, to finish the events that were still in BigQuery's streaming buffer and to forget
 * accounts deleted in sign-in v2 (learner_accounts.status = deleted), e.g. 02:00 IST:
 *   0 2 * * * cd /opt/multibhashi-admin && docker compose -f deploy/docker-compose.yml exec -T admin-api node ace analytics:forget-user --scheduled
 */
export default class AnalyticsForgetUser extends BaseCommand {
  static commandName = 'analytics:forget-user'
  static description = 'Delete a learner (appspot _id or teachers-dashboard users.id) from product analytics: events, facts, models'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'The appspot _id or the teachers-dashboard users.id', required: false })
  declare id?: string

  @flags.boolean({ description: 'Count the rows that would be deleted; delete nothing' })
  declare dryRun?: boolean

  @flags.boolean({ description: 'Re-run the last 7 days of requests and forget accounts deleted in sign-in v2' })
  declare scheduled?: boolean

  @flags.string({ description: 'Why (a ticket or a sentence), for the audit log' })
  declare reason?: string

  async run() {
    const { openWarehouse } = await import('#services/product_analytics/warehouse')
    const { accountsFromMysql, forgetLearner, logForget, parseSubject, scheduledSubjects } = await import('#services/product_analytics/forget')
    const { default: auditService } = await import('#services/audit_service')

    if (!this.id && !this.scheduled) {
      this.logger.error('Give an appspot _id or a teachers-dashboard users.id (or --scheduled).')
      this.exitCode = 1
      return
    }
    let work: { subject: ReturnType<typeof parseSubject>; source: 'command' | 'deleted_account' | 'rerun' }[]
    try {
      work = this.scheduled ? await scheduledSubjects() : [{ subject: parseSubject(this.id!), source: 'command' }]
    } catch (error) {
      this.logger.error((error as Error).message)
      this.exitCode = 1
      return
    }
    const warehouse = await openWarehouse()
    if (!warehouse.client || !warehouse.refs) {
      const why = warehouse.config.problem ?? `missing ${warehouse.config.missing.join(', ')}`
      this.logger.info(`Product analytics is not connected (${why}): nothing to delete in BigQuery.`)
      return
    }
    if (!work.length) {
      this.logger.info('Nothing scheduled.')
      return
    }

    let failed = 0
    for (const item of work) {
      try {
        const result = await forgetLearner(item.subject, {
          warehouse: warehouse.client,
          refs: warehouse.refs,
          accounts: accountsFromMysql,
          dryRun: !!this.dryRun,
          log: (line) => this.logger.info(line),
        })
        if (this.dryRun) continue
        await logForget(result, item.source)
        const deleted = Object.fromEntries(result.tables.map((t) => [t.table, t.rows]))
        await auditService.record({
          actorEmail: 'cli:analytics:forget-user',
          action: 'analytics.learner.forgotten',
          targetType: 'learner',
          targetId: result.ids.tdUserIds[0] ?? null,
          reason: this.reason ?? (item.source === 'command' ? null : item.source),
          metadata: { source: item.source, app_ids: result.ids.appspotIds.length, device_ids: result.ids.anonymousIds.length, deleted },
        })
        const total = result.tables.reduce((s, t) => s + (typeof t.rows === 'number' ? t.rows : 0), 0)
        this.logger.success(`Forgotten (${item.source}): ${total} row(s) deleted. Today's and yesterday's events go with the next --scheduled runs.`)
      } catch (error) {
        failed++
        this.logger.error(`forget-user failed: ${String((error as Error).message ?? error).slice(0, 300)}`)
      }
    }
    if (failed) this.exitCode = 1
  }
}
