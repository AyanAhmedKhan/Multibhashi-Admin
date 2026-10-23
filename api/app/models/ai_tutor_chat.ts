import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * A tutoring session. Maps the shared `ai_tutor_chats` table.
 * Property names are camelCase; Lucid maps them to snake_case columns.
 */
export default class AiTutorChat extends BaseModel {
  static table = 'ai_tutor_chats'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number

  @column()
  declare quizId: number | null

  @column()
  declare quizQuestionId: number | null

  @column()
  declare roomName: string | null

  @column()
  declare status: string | null

  @column()
  declare totalMinutes: number | null

  @column()
  declare remainingMinutes: number | null

  @column()
  declare timeSpent: number | null

  @column()
  declare lessonContent: string | null

  @column()
  declare lessonTopic: string | null

  @column()
  declare chatStartTimestamp: number | null

  @column()
  declare chatEndTimestamp: number | null

  @column()
  declare parentSessionId: number | null

  // Reset: history starts after this ai_tutor_chat_details id (null = the whole history)
  @column()
  declare historyStartDetailId: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
