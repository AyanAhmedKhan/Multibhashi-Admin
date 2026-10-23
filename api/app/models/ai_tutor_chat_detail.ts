import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * A single chat message within a session. Maps `ai_tutor_chat_details`.
 */
export default class AiTutorChatDetail extends BaseModel {
  static table = 'ai_tutor_chat_details'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare aiTutorChatId: number

  @column()
  declare chat: string

  @column()
  declare chatFrom: string

  @column()
  declare chatType: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
