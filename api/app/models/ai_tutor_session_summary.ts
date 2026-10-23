import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export interface SessionSummaryDetails {
  topics?: string[]
  words_practised?: string[]
  mistakes?: string[]
  next_steps?: string[]
  /** shown to the learner ("You practised …"); the summary itself is written for the tutor */
  recap_for_learner?: string
}

const json = {
  prepare: (value: unknown) =>
    value === null || value === undefined ? null : JSON.stringify(value),
  consume: (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value),
}

/**
 * What happened in one class. Maps `ai_tutor_session_summaries`.
 */
export default class AiTutorSessionSummary extends BaseModel {
  static table = 'ai_tutor_session_summaries'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare aiTutorChatId: number

  @column()
  declare userId: number

  @column()
  declare quizId: number | null

  @column()
  declare language: string | null

  @column()
  declare summary: string

  @column(json)
  declare details: SessionSummaryDetails | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
