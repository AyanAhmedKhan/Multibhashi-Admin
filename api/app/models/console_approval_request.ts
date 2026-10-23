import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'failed'

const json = {
  prepare: (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value)),
  consume: (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value),
}

/**
 * A four-eyes request. Maps `console_approval_requests`.
 */
export default class ConsoleApprovalRequest extends BaseModel {
  static table = 'console_approval_requests'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare action: string

  @column(json)
  declare payload: Record<string, unknown>

  @column()
  declare summary: string

  @column()
  declare status: ApprovalStatus

  @column()
  declare requestedBy: number

  @column()
  declare requestReason: string

  @column()
  declare decidedBy: number | null

  @column.dateTime()
  declare decidedAt: DateTime | null

  @column()
  declare decisionNote: string | null

  @column.dateTime()
  declare executedAt: DateTime | null

  @column(json)
  declare result: Record<string, unknown> | null

  @column()
  declare error: string | null

  @column.dateTime()
  declare expiresAt: DateTime

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
