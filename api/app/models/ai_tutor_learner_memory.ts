import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export interface LearnerLanguageMemory {
  level?: string
  strengths?: string[]
  struggles?: string[]
  mastered?: string[]
  practice_next?: string[]
}

/** Shape written by the agent's reflection (agent/memory.js sanitizeProfile). */
export interface LearnerProfile {
  facts?: string[]
  preferences?: string[]
  languages?: Record<string, LearnerLanguageMemory>
}

const json = {
  prepare: (value: unknown) => JSON.stringify(value ?? {}),
  consume: (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value),
}

/**
 * Long-term tutor memory of one learner. Maps `ai_tutor_learner_memories`.
 */
export default class AiTutorLearnerMemory extends BaseModel {
  static table = 'ai_tutor_learner_memories'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number

  @column()
  declare scope: string

  @column(json)
  declare memory: LearnerProfile

  @column()
  declare version: number

  /** version written by the last "forget everything"; writers based on an older one are stale */
  @column()
  declare erasedVersion: number | null

  @column.dateTime()
  declare erasedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
