import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export type StaffStatus = 'invited' | 'active' | 'disabled'

const jsonList = {
  prepare: (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value)),
  consume: (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value),
}

/**
 * A staff account. Maps `console_users`. Secrets (password hash, MFA secrets, recovery
 * code hashes, setup token) are never serialised.
 */
export default class ConsoleUser extends BaseModel {
  static table = 'console_users'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare email: string

  @column()
  declare name: string

  @column({ serializeAs: null })
  declare passwordHash: string | null

  @column()
  declare status: StaffStatus

  @column({ serializeAs: null })
  declare mfaSecret: string | null

  @column({ serializeAs: null })
  declare mfaPendingSecret: string | null

  @column.dateTime()
  declare mfaEnabledAt: DateTime | null

  @column({ serializeAs: null })
  declare mfaLastStep: number | null

  @column({ ...jsonList, serializeAs: null })
  declare recoveryCodes: string[] | null

  @column({ serializeAs: null })
  declare setupTokenHash: string | null

  @column.dateTime()
  declare setupExpiresAt: DateTime | null

  @column()
  declare failedLogins: number

  @column.dateTime()
  declare lockedUntil: DateTime | null

  @column.dateTime()
  declare lastLoginAt: DateTime | null

  @column()
  declare lastLoginIp: string | null

  @column.dateTime()
  declare passwordChangedAt: DateTime | null

  @column.dateTime()
  declare disabledAt: DateTime | null

  @column()
  declare disabledReason: string | null

  @column()
  declare createdBy: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
