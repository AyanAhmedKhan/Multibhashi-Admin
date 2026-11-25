import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Pulls the providers' own daily usage and billing — the whole OpenAI organisation (Usage +
 * Costs APIs) and the whole GCP billing account (billing export) — into
 * console_ai_provider_daily; quiz/tutor attribution happens when reading. Idempotent: each run replaces its
 * window. Meant for a daily system cron, e.g. 03:15 IST:
 *   docker compose -f deploy/docker-compose.yml exec -T admin-api node ace quiz:sync-provider-usage --days 7
 * A provider without credentials is reported as "not connected" and skipped.
 */
export default class QuizSyncProviderUsage extends BaseCommand {
  static commandName = 'quiz:sync-provider-usage'
  static description = 'Sync the whole OpenAI and GCP bill (usage, cost, credits) for the last N IST days'
  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'How many IST days back, today included (1–90)', default: 7 })
  declare days: number

  async run() {
    const { default: providerSync } = await import('#services/analytics/provider_sync')
    const result = await providerSync.run(this.days ?? 7)
    let failed = false
    for (const provider of ['openai', 'google'] as const) {
      const r = result[provider]
      if ('connected' in r) {
        const why = 'problem' in r && r.problem ? r.problem : `missing ${r.missing.join(', ')}`
        this.logger.info(`${provider}: not connected (${why})`)
      } else if (r.ok) {
        this.logger.success(`${provider}: ${r.rows} rows for the last ${r.days} days${r.dataThrough ? `, data through ${r.dataThrough}` : ''}`)
      } else {
        failed = true
        this.logger.error(`${provider}: ${r.error}`)
      }
    }
    if (failed) this.exitCode = 1
  }
}
