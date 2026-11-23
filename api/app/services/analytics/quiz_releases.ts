import db from '@adonisjs/lucid/services/db'
import ApiException from '#exceptions/api_exception'
import auditService from '#services/audit_service'
import type { Actor } from '#services/actor'

/**
 * The quiz release log (console_quiz_releases, docs/QUIZ_OBSERVABILITY.md §7): every change
 * that can move a quiz metric, with when it reached learners. Before/after windows are cut at
 * deployed_at; confounders (a navigation change, a bulk assignment) are logged too, so a jump
 * that isn't a fix's doing can be explained. Every write is audited.
 */

export const RELEASE_KINDS = ['fix', 'telemetry', 'confounder'] as const
export const RELEASE_SURFACES = ['app_web', 'app_android', 'app_ios', 'backend', 'admin'] as const
export const RELEASE_PHASES = ['0', '1', '2', '3', '4', '5', '6'] as const
export const DIRECTIONS = ['up', 'down', 'flat'] as const

export interface Expectation {
  metric: string
  direction: (typeof DIRECTIONS)[number]
}

export interface ReleaseInput {
  title: string
  phase?: string | null
  kind: (typeof RELEASE_KINDS)[number]
  surface: (typeof RELEASE_SURFACES)[number]
  ticket?: string | null
  pr?: string | null
  commitSha?: string | null
  appVersion?: string | null
  /** ISO 8601 with an offset, or null while it hasn't reached learners. */
  deployedAt?: string | null
  deployedEstimated?: boolean
  expects?: Expectation[] | null
  notes?: string | null
}

export interface Release extends Omit<ReleaseInput, 'deployedAt'> {
  id: number
  deployedAt: string | null
  deployedEstimated: boolean
  createdAt: string
  updatedAt: string
}

const TABLE = 'console_quiz_releases'
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString())

const parseExpects = (v: unknown): Expectation[] | null => {
  if (v === null || v === undefined) return null
  try {
    const list = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(list) ? (list as Expectation[]) : null
  } catch {
    return null
  }
}

function toRelease(r: Record<string, unknown>): Release {
  return {
    id: Number(r.id),
    title: String(r.title),
    phase: (r.phase as string) ?? null,
    kind: r.kind as Release['kind'],
    surface: r.surface as Release['surface'],
    ticket: (r.ticket as string) ?? null,
    pr: (r.pr as string) ?? null,
    commitSha: (r.commit_sha as string) ?? null,
    appVersion: (r.app_version as string) ?? null,
    deployedAt: iso(r.deployed_at),
    deployedEstimated: !!r.deployed_estimated,
    expects: parseExpects(r.expects),
    notes: (r.notes as string) ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  }
}

function columns(input: ReleaseInput) {
  return {
    title: input.title.trim().slice(0, 160),
    phase: input.phase ?? null,
    kind: input.kind,
    surface: input.surface,
    ticket: input.ticket?.trim() || null,
    pr: input.pr?.trim() || null,
    commit_sha: input.commitSha?.trim().toLowerCase() || null,
    app_version: input.appVersion?.trim() || null,
    deployed_at: input.deployedAt ? new Date(input.deployedAt) : null,
    deployed_estimated: input.deployedAt ? !!input.deployedEstimated : false,
    expects: input.expects?.length ? JSON.stringify(input.expects) : null,
    notes: input.notes?.trim() || null,
  }
}

/**
 * Changes that were live before the release log existed (2026-11-23). Times are the merge or
 * commit time in IST, so they are marked estimated: the web and backend deploy times weren't
 * recorded. Correct them in the console once Ashish confirms the deploys.
 */
export const SEED_RELEASES: ReleaseInput[] = [
  {
    title: 'LSRW scoring: question-average scores and CEFR band corrections',
    kind: 'confounder',
    surface: 'backend',
    pr: 'teachers-dashboard #28',
    commitSha: '73325af6',
    deployedAt: '2026-10-28T21:44:28+05:30',
    deployedEstimated: true,
    notes: 'Changes how scores roll up; watch the pass-rate and score guardrails around this date.',
  },
  {
    title: 'Bulk quiz assignment on the Assignments tab',
    kind: 'confounder',
    surface: 'backend',
    commitSha: '0aa7d9bc',
    deployedAt: '2026-11-02T11:50:38+05:30',
    deployedEstimated: true,
    notes: 'Can raise answer volume in bursts (B2B batches).',
  },
  {
    title: 'Quiz list popup redesign',
    kind: 'confounder',
    surface: 'app_web',
    pr: 'RN #36',
    commitSha: '16accc1',
    deployedAt: '2026-11-02T12:33:21+05:30',
    deployedEstimated: true,
  },
  {
    title: 'Quiz progress, attempt counts and the admin quiz form',
    kind: 'confounder',
    surface: 'backend',
    commitSha: 'ba17549d',
    deployedAt: '2026-11-03T12:08:43+05:30',
    deployedEstimated: true,
  },
  {
    title: 'Learner dashboard redesign',
    kind: 'confounder',
    surface: 'app_web',
    pr: 'RN #37',
    commitSha: 'cfae18a',
    deployedAt: '2026-11-12T17:29:18+05:30',
    deployedEstimated: true,
    notes: 'Changes how learners reach quizzes; can move volume.',
  },
  {
    title: '"Quizzes" renamed "All Modules"',
    kind: 'confounder',
    surface: 'app_web',
    pr: 'RN #41',
    commitSha: '5ade420',
    deployedAt: '2026-11-16T12:26:43+05:30',
    deployedEstimated: true,
  },
  {
    title: 'Microphone help per device; iPhone recordings keep their real type',
    kind: 'fix',
    surface: 'app_web',
    ticket: 'MUL-101, MUL-102',
    pr: 'RN #42',
    commitSha: 'bfbcd3f',
    deployedAt: '2026-11-16T16:40:31+05:30',
    deployedEstimated: true,
    expects: [
      { metric: 'sq_no_speech_share', direction: 'down' },
      { metric: 'sq_marking_failed_share', direction: 'down' },
      { metric: 'sw_attempt_finished_share', direction: 'up' },
    ],
    notes: 'MUL-102 should show on iPhones (os:ios once the quiz events ship); before that, device:web only.',
  },
  {
    title: 'Quiz screens on phones: option rows, Continue bar, saving state, feedback and passage layout',
    kind: 'fix',
    surface: 'app_web',
    ticket: 'MUL-71, 89, 90, 91, 107',
    pr: 'RN #39, #42',
    commitSha: 'bfbcd3f',
    deployedAt: '2026-11-16T16:40:31+05:30',
    deployedEstimated: true,
    expects: [
      { metric: 'attempt_finished_share', direction: 'up' },
      { metric: 'sw_attempt_finished_share', direction: 'up' },
    ],
  },
  {
    title: 'Bulk students on assignments; quiz progress fixes',
    kind: 'confounder',
    surface: 'backend',
    commitSha: '88b13d46',
    deployedAt: '2026-11-16T20:13:59+05:30',
    deployedEstimated: true,
    notes: '17–19 Nov ran at about 3× the usual Speaking answers (9.6K–12.4K a day); bulk assignment is the likely cause.',
  },
  {
    title: 'Mobile web: remaining audit fixes (startup JS, scroll restore, notifications, phone polish)',
    kind: 'confounder',
    surface: 'app_web',
    ticket: 'MUL-79, 108, 110, 113-116',
    pr: 'RN #43',
    commitSha: 'c72b9af',
    // Vercel's production deployment of this commit reported success at 18:04:21 UTC
    deployedAt: '2026-11-23T23:34:21+05:30',
    notes: 'Not quiz-specific; can move how learners reach and resume quizzes.',
  },
  {
    title: 'Activity data: app version on every session, a real quiz_completed',
    kind: 'telemetry',
    surface: 'app_web',
    ticket: 'MUL-143',
    pr: 'RN #44',
    commitSha: '42994e1',
    deployedAt: '2026-11-23T23:35:08+05:30',
    notes: 'From here student_sessions.app_version is set, so app-side metrics can be split by app version.',
  },
  {
    title: 'Quiz events: what learners go through on Speaking and Writing questions',
    kind: 'telemetry',
    surface: 'app_web',
    pr: 'RN #45',
    commitSha: 'd3335bf',
    // Vercel production deployment of the merge, success at 18:05:27 UTC
    deployedAt: '2026-11-23T23:35:27+05:30',
    notes: 'The app-side baseline starts here (os, in_app, recording, submit and timeout events). Phases 1, 4 and 5 wait about 14 days of it.',
  },
]

class QuizReleases {
  async list(): Promise<Release[]> {
    // Not yet deployed first, then newest first
    const rows = await db.from(TABLE).orderByRaw('deployed_at IS NULL DESC').orderBy('deployed_at', 'desc').orderBy('id', 'desc')
    return rows.map(toRelease)
  }

  async find(id: number) {
    const row = await db.from(TABLE).where('id', id).first()
    if (!row) throw new ApiException(404, 'That change is not in the release log', 'NOT_FOUND')
    return toRelease(row)
  }

  async create(actor: Actor, input: ReleaseInput) {
    const now = new Date()
    return db.transaction(async (trx) => {
      const [id] = await trx.table(TABLE).insert({ ...columns(input), created_by: actor.user.id, updated_by: actor.user.id, created_at: now, updated_at: now })
      await auditService.record(
        { actor, action: 'analytics.quiz_release.created', targetType: 'quiz_release', targetId: String(id), metadata: { title: input.title, deployed_at: input.deployedAt ?? null } },
        trx
      )
      return toRelease((await trx.from(TABLE).where('id', id).first())!)
    })
  }

  async update(actor: Actor, id: number, input: ReleaseInput) {
    const before = await this.find(id)
    return db.transaction(async (trx) => {
      await trx.from(TABLE).where('id', id).update({ ...columns(input), updated_by: actor.user.id, updated_at: new Date() })
      await auditService.record(
        {
          actor,
          action: 'analytics.quiz_release.updated',
          targetType: 'quiz_release',
          targetId: String(id),
          metadata: { title: input.title, before_deployed_at: before.deployedAt, after_deployed_at: input.deployedAt ?? null },
        },
        trx
      )
      return toRelease((await trx.from(TABLE).where('id', id).first())!)
    })
  }

  async remove(actor: Actor, id: number, reason: string) {
    const before = await this.find(id)
    await db.transaction(async (trx) => {
      await trx.from(TABLE).where('id', id).delete()
      await auditService.record(
        { actor, action: 'analytics.quiz_release.deleted', targetType: 'quiz_release', targetId: String(id), reason, metadata: { title: before.title, deployed_at: before.deployedAt } },
        trx
      )
    })
  }

  /** Adds the SEED_RELEASES whose title isn't in the log yet. Returns how many were added. */
  async seed() {
    const titles = new Set((await db.from(TABLE).select('title')).map((r: { title: string }) => r.title))
    const missing = SEED_RELEASES.filter((r) => !titles.has(r.title))
    const now = new Date()
    if (missing.length) {
      await db.transaction(async (trx) => {
        await trx.table(TABLE).multiInsert(missing.map((r) => ({ ...columns(r), created_at: now, updated_at: now })))
        await auditService.record(
          { actorEmail: 'quiz:seed-releases', action: 'analytics.quiz_release.seeded', targetType: 'quiz_release', metadata: { added: missing.map((r) => r.title) } },
          trx
        )
      })
    }
    return missing.length
  }
}

export default new QuizReleases()
