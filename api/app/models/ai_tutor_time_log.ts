import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Minutes-granted ledger (source of truth for a user's available time).
 * Maps `ai_tutor_time_logs`.
 */
export default class AiTutorTimeLog extends BaseModel {
  static table = 'ai_tutor_time_logs'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number

  @column()
  declare quizQuestionId: number | null

  @column()
  declare aiTutorChatId: number | null

  @column()
  declare source: string | null

  @column()
  declare minutesAdded: number | null

  @column()
  declare previousTotal: number | null

  @column()
  declare newTotal: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
