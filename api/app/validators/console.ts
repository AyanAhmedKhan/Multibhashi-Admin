import vine from '@vinejs/vine'
import { LEARNER_NAME } from '#helpers/learner_name'

/**
 * Every sensitive read and every write asks "why?". The reason is stored in the audit
 * log next to the action (a ticket number or a sentence is enough).
 */
const reason = () => vine.string().trim().minLength(5).maxLength(500)

export const loginValidator = vine.compile(
  vine.object({
    email: vine.string().trim().maxLength(254),
    password: vine.string().maxLength(256),
  })
)

export const codeValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(20),
  })
)

export const setupValidator = vine.compile(
  vine.object({
    password: vine.string().maxLength(256),
    code: vine.string().trim().maxLength(20).optional(),
  })
)

export const stepUpValidator = vine.compile(
  vine.object({
    code: vine.string().trim().maxLength(20).optional(),
    password: vine.string().maxLength(256).optional(),
  })
)

export const changePasswordValidator = vine.compile(
  vine.object({
    current: vine.string().maxLength(256),
    password: vine.string().maxLength(256),
  })
)

export const reasonValidator = vine.compile(vine.object({ reason: reason() }))

export const inviteValidator = vine.compile(
  vine.object({
    email: vine.string().trim().maxLength(254),
    name: vine.string().trim().minLength(2).maxLength(120),
    roles: vine.array(vine.number().withoutDecimals()).minLength(1).maxLength(20),
    reason: reason(),
    send_email: vine.boolean().optional(),
  })
)

export const reissueValidator = vine.compile(vine.object({ send_email: vine.boolean().optional() }))

export const renameValidator = vine.compile(
  vine.object({ name: vine.string().trim().minLength(2).maxLength(120) })
)

export const learnerNameValidator = vine.compile(
  vine.object({
    name: vine
      .string()
      .trim()
      .minLength(2)
      .maxLength(60)
      .regex(LEARNER_NAME)
      .transform((v) => v.replace(/\s+/g, ' ')),
    reason: reason(),
  })
)

export const rolesValidator = vine.compile(
  vine.object({
    roles: vine.array(vine.number().withoutDecimals()).maxLength(20),
    reason: reason(),
  })
)

export const roleValidator = vine.compile(
  vine.object({
    slug: vine.string().trim().optional(),
    name: vine.string().trim().minLength(2).maxLength(80),
    description: vine.string().trim().maxLength(255).optional(),
    permissions: vine.array(vine.string().trim().maxLength(64)).minLength(1).maxLength(200),
    reason: reason(),
  })
)

export const decisionValidator = vine.compile(
  vine.object({
    decision: vine.enum(['approve', 'reject']),
    note: reason(),
  })
)

export const settingsValidator = vine.compile(
  vine.object({
    changes: vine.record(vine.any()),
    reason: reason(),
  })
)

export const grantValidator = vine.compile(
  vine.object({
    minutes: vine.number().withoutDecimals().min(-3000).max(3000),
    reason: reason(),
  })
)

export const aiProValidator = vine.compile(
  vine.object({
    course_id: vine.number().withoutDecimals().min(1),
    level_name: vine.string().trim().minLength(1).maxLength(64),
    from_lesson: vine.number().withoutDecimals().min(0).max(10_000),
    to_lesson: vine.number().withoutDecimals().min(0).max(10_000),
    lesson_field: vine.enum(['lesson_number', 'lesson_order']).optional(),
    minutes_per_card: vine.number().withoutDecimals().min(0).max(600),
    validity_days: vine.number().withoutDecimals().min(1).max(730),
    with_plan: vine.boolean(),
    with_access: vine.boolean(),
    package_name: vine.string().trim().maxLength(64).optional(),
    reason: vine.string().trim().minLength(5).maxLength(500).optional(),
  })
)

export const extendValidator = vine.compile(
  vine.object({ days: vine.number().withoutDecimals().min(1).max(365), reason: reason() })
)

export const endGrantValidator = vine.compile(
  vine.object({ remove_unused_minutes: vine.boolean().optional(), reason: reason() })
)

export const invoiceValidator = vine.compile(
  vine.object({
    month: vine.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    provider: vine.enum(['sarvam', 'google', 'livekit', 'other']),
    amount_inr: vine.number().min(0).max(100_000_000),
    note: vine.string().trim().maxLength(255).optional(),
    reason: reason(),
  })
)

export const costModelValidator = vine.compile(
  vine.object({ model: vine.any(), reason: reason() })
)

export const listValidator = vine.compile(
  vine.object({
    page: vine.number().withoutDecimals().min(1).max(10_000).optional(),
    perPage: vine.number().withoutDecimals().min(5).max(100).optional(),
    q: vine.string().trim().maxLength(120).optional(),
    status: vine.string().trim().maxLength(32).optional(),
    source: vine.string().trim().maxLength(32).optional(),
    userId: vine.number().withoutDecimals().min(1).optional(),
    from: vine.date({ formats: ['YYYY-MM-DD'] }).optional(),
    to: vine.date({ formats: ['YYYY-MM-DD'] }).optional(),
    action: vine.string().trim().maxLength(64).optional(),
    actorId: vine.number().withoutDecimals().min(1).optional(),
    targetType: vine.string().trim().maxLength(32).optional(),
    targetId: vine.string().trim().maxLength(64).optional(),
    outcome: vine.enum(['success', 'denied', 'failure']).optional(),
    days: vine.number().withoutDecimals().in([7, 14, 30, 90]).optional(),
    courseId: vine.number().withoutDecimals().min(1).optional(),
  })
)
