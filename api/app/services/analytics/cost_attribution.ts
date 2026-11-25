import { isSpeechSku } from '#services/analytics/gcp_billing'

/**
 * Which part of the providers' WHOLE bill belongs to what. The sync stores every GCP
 * project/service/SKU and every OpenAI project/key/model unfiltered; these rules are applied
 * when reading, so changing a rule re-attributes history without a re-sync.
 *
 * - quizzes: Google speech-to-text SKUs in the speech project (GCP_SPEECH_PROJECT_ID; any
 *   project when unset — the quiz Speaking upload is the only speech-to-text caller) and the
 *   OpenAI usage of the quiz backend's project/keys (OPENAI_QUIZ_PROJECT_ID /
 *   OPENAI_QUIZ_API_KEY_IDS; the whole organisation when neither is set, docs §6);
 * - tutor: the AI tutor's Gemini project on GCP. Its other providers (Sarvam, LiveKit) have
 *   no billing API and come from Finance's monthly bills;
 * - other: everything else (unattributed).
 */

/** The only project with the Gemini API (the tutor's); billing is off there (free tier) as of 29 Oct 2026. */
export const TUTOR_GEMINI_PROJECT = 'gen-lang-client-0382165857'

export type Bucket = 'quizzes' | 'tutor' | 'other'
export const BUCKETS: Bucket[] = ['quizzes', 'tutor', 'other']

export interface AttributionRules {
  /** GCP project whose speech-to-text is the quizzes'; null = any project. */
  speechProject: string | null
  openaiQuizProjects: string[]
  openaiQuizKeys: string[]
  /** GCP projects that are the AI tutor's. */
  tutorGcpProjects: string[]
}

export interface AttributableRow {
  provider: string
  scope: string
  item: string
  source: string
}

/** OpenAI scope "project" or "project/key". */
export function splitScope(scope: string) {
  const i = scope.indexOf('/')
  return i < 0 ? { project: scope, key: null as string | null } : { project: scope.slice(0, i), key: scope.slice(i + 1) }
}

/**
 * Whether an OpenAI row is the quiz backend's: true / false, or null when a key rule is set
 * but the row isn't broken down by key (Costs API without key grouping).
 */
export function openaiIsQuiz(scope: string, rules: AttributionRules): boolean | null {
  if (!rules.openaiQuizProjects.length && !rules.openaiQuizKeys.length) return true
  const { project, key } = splitScope(scope)
  if (rules.openaiQuizProjects.length && !rules.openaiQuizProjects.includes(project)) return false
  if (!rules.openaiQuizKeys.length) return true
  if (key === null) return null
  return rules.openaiQuizKeys.includes(key)
}

export function googleIsQuizSpeech(row: Pick<AttributableRow, 'scope' | 'item'>, rules: AttributionRules) {
  return isSpeechSku(row.item) && (!rules.speechProject || row.scope === rules.speechProject)
}

/** The bucket of one synced row (null = OpenAI row that can't be told apart by key). */
export function attribute(row: AttributableRow, rules: AttributionRules): { bucket: Bucket | null; part: 'speech' | 'marking' | null } {
  if (row.provider === 'google') {
    if (rules.tutorGcpProjects.includes(row.scope)) return { bucket: 'tutor', part: null }
    if (googleIsQuizSpeech(row, rules)) return { bucket: 'quizzes', part: 'speech' }
    return { bucket: 'other', part: null }
  }
  if (row.provider === 'openai') {
    const quiz = openaiIsQuiz(row.scope, rules)
    return quiz === null ? { bucket: null, part: 'marking' } : quiz ? { bucket: 'quizzes', part: 'marking' } : { bucket: 'other', part: null }
  }
  return { bucket: 'other', part: null }
}

/** Human description of the rules, for the page. */
export function describeRules(rules: AttributionRules) {
  return {
    speech: rules.speechProject ? `speech-to-text SKUs in ${rules.speechProject}` : 'speech-to-text SKUs in any project (GCP_SPEECH_PROJECT_ID not set)',
    marking:
      rules.openaiQuizProjects.length || rules.openaiQuizKeys.length
        ? `OpenAI ${[...rules.openaiQuizProjects.map((p) => `project ${p}`), ...rules.openaiQuizKeys.map((k) => `key ${k}`)].join(', ')}`
        : 'all of OpenAI (OPENAI_QUIZ_PROJECT_ID / OPENAI_QUIZ_API_KEY_IDS not set)',
    tutor: `GCP project ${rules.tutorGcpProjects.join(', ')} (Gemini); Sarvam and LiveKit from Finance's monthly bills`,
  }
}
