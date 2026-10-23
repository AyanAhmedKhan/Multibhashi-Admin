import db from '@adonisjs/lucid/services/db'
import proxyAddr from 'proxy-addr'
import consoleConfig, { type ConsoleSettings } from '#config/console'
import ApiException from '#exceptions/api_exception'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

type Key = keyof ConsoleSettings

/** Bounds for each tunable: a typo can't disable lockout or make sessions last a year. */
const BOUNDS: Record<Exclude<Key, 'ip_allowlist'>, [number, number]> = {
  session_idle_minutes: [5, 240],
  session_absolute_hours: [1, 24],
  step_up_minutes: [1, 60],
  login_max_failures: [3, 20],
  lockout_minutes: [1, 1440],
  grant_minutes_direct_limit: [0, 600],
  grant_minutes_max: [1, 3000],
  ai_pro_direct_max_days: [0, 365],
  ai_pro_direct_max_minutes: [0, 10_000],
}

const CACHE_MS = 15_000

class SettingsService {
  #cache: { at: number; value: ConsoleSettings } | null = null

  async all(): Promise<ConsoleSettings> {
    if (this.#cache && Date.now() - this.#cache.at < CACHE_MS) return this.#cache.value
    const rows = await db.from('console_settings').select('key', 'value')
    const value = { ...consoleConfig.defaults }
    for (const row of rows) {
      if (row.key in value) {
        ;(value as Record<string, unknown>)[row.key] =
          typeof row.value === 'string' ? JSON.parse(row.value) : row.value
      }
    }
    this.#cache = { at: Date.now(), value }
    return value
  }

  /** Validates every key first, then writes them all; returns the old values (for the audit). */
  async update(changes: Partial<ConsoleSettings>, userId: number, trx: TransactionClientContract) {
    const current = await this.all()
    const before: Partial<ConsoleSettings> = {}
    for (const [key, raw] of Object.entries(changes) as [Key, unknown][]) {
      if (!(key in consoleConfig.defaults)) throw new ApiException(422, `Unknown setting ${key}`)
      if (key === 'ip_allowlist') {
        if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
          throw new ApiException(422, 'ip_allowlist must be a list of IPs or CIDR ranges')
        }
        try {
          proxyAddr.compile(raw as string[])
        } catch {
          throw new ApiException(422, 'ip_allowlist has an invalid IP or CIDR range')
        }
      } else {
        const [min, max] = BOUNDS[key]
        if (!Number.isInteger(raw) || (raw as number) < min || (raw as number) > max) {
          throw new ApiException(422, `${key} must be a whole number from ${min} to ${max}`)
        }
      }
      ;(before as Record<string, unknown>)[key] = current[key]
    }
    for (const [key, value] of Object.entries(changes)) {
      await trx
        .insertQuery()
        .table('console_settings')
        .insert({ key, value: JSON.stringify(value), updated_by: userId, updated_at: new Date() })
        .knexQuery.onConflict('key')
        .merge()
    }
    this.#cache = null
    return before
  }

  /** True when the allowlist is empty (off) or contains the IP. */
  async ipAllowed(ip: string) {
    const { ip_allowlist: list } = await this.all()
    if (!list.length) return true
    return proxyAddr.compile(list)(ip, 0)
  }
}

export default new SettingsService()
