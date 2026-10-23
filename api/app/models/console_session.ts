import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export type SessionState = 'mfa_pending' | 'active'

/**
 * A staff sign-in. Maps `console_sessions`; the cookie carries the token, this row only
 * its SHA-256.
 */
export default class ConsoleSession extends BaseModel {
  static table = 'console_sessions'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number

  @column({ serializeAs: null })
  declare tokenHash: string

  @column({ serializeAs: null })
  declare csrfToken: string

  @column()
  declare state: SessionState

  @column()
  declare ip: string | null

  @column()
  declare userAgent: string | null

  @column.dateTime()
  declare mfaAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime()
  declare lastSeenAt: DateTime | null

  @column.dateTime()
  declare expiresAt: DateTime

  @column.dateTime()
  declare revokedAt: DateTime | null

  @column()
  declare revokedReason: string | null
}
