import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * The Monday product digest (MUL-152, docs/PRODUCT_ANALYTICS.md §4): last week's KPIs, the
 * biggest week-on-week changes and the top drop-off step, e-mailed through the console's
 * mailer to ANALYTICS_DIGEST_TO (comma-separated). Aggregates only.
 *
 * Mondays after the nightly models, e.g. 09:00 IST, from the host's crontab:
 *   0 9 * * 1 cd /opt/multibhashi-admin && docker compose -f deploy/docker-compose.yml exec -T admin-api node ace analytics:weekly-digest
 * Preview without sending: --dry-run (prints the subject, text and HTML). --sample renders
 * example numbers without BigQuery, to check the layout.
 */
export default class AnalyticsWeeklyDigest extends BaseCommand {
  static commandName = 'analytics:weekly-digest'
  static description = 'E-mail the weekly product analytics digest (KPIs, biggest changes, top drop-off) to ANALYTICS_DIGEST_TO'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Print the e-mail instead of sending it' })
  declare dryRun?: boolean

  @flags.boolean({ description: 'Use example numbers (no BigQuery): to preview the layout' })
  declare sample?: boolean

  @flags.string({ description: 'Any IST day in the week after the one to report (default: today)' })
  declare today?: string

  async run() {
    const { default: env } = await import('#start/env')
    const { istDayLabel, istDayOf } = await import('#helpers/ist')
    const { SAMPLE_DIGEST, digestData, lastFullWeek, recipients, renderDigest } = await import('#services/product_analytics/digest')
    const { default: insights } = await import('#services/product_analytics/insights')

    const today = this.today ?? istDayLabel(istDayOf(Date.now()))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      this.logger.error('--today must be YYYY-MM-DD')
      this.exitCode = 1
      return
    }
    const origin = (env.get('CONSOLE_ORIGINS') ?? '').split(',')[0]?.trim()
    const link = origin ? `${origin.replace(/\/$/, '')}/insights/overview?days=7` : null

    let data = SAMPLE_DIGEST
    if (!this.sample) {
      const result = await digestData(insights, lastFullWeek(today), link)
      if (!result.ok) {
        this.logger.info(`No digest: ${result.reason}`)
        return
      }
      data = result.data
    }
    const mail = renderDigest(data)
    if (this.dryRun) {
      this.logger.log(`Subject: ${mail.subject}\n\n${mail.text}\n\n----- HTML -----\n${mail.html}`)
      return
    }

    const to = recipients(env.get('ANALYTICS_DIGEST_TO'))
    if (to.invalid.length) this.logger.warning(`ANALYTICS_DIGEST_TO: ${to.invalid.length} entr${to.invalid.length === 1 ? 'y is' : 'ies are'} not an e-mail address and skipped`)
    if (!to.valid.length) {
      this.logger.info('ANALYTICS_DIGEST_TO is not set: nothing sent (use --dry-run to see the digest).')
      return
    }
    const { default: mailService } = await import('#services/mail_service')
    let failed = 0
    for (const address of to.valid) {
      try {
        const sent = await mailService.send({ to: address, subject: mail.subject, text: mail.text, html: mail.html })
        this.logger.info(`sent (${sent.delivered}) to recipient ${to.valid.indexOf(address) + 1} of ${to.valid.length}`)
      } catch (error) {
        failed++
        this.logger.error(`recipient ${to.valid.indexOf(address) + 1}: ${String((error as Error).message ?? error).slice(0, 200)}`)
      }
    }
    if (failed) this.exitCode = 1
    else this.logger.success(`Digest for ${data.week.from} → ${data.week.to} sent to ${to.valid.length} recipient(s).`)
  }
}
