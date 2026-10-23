import db from '@adonisjs/lucid/services/db'
import ApiException from '#exceptions/api_exception'
import auditService from '#services/audit_service'
import approvalService from '#services/approval_service'
import settingsService from '#services/settings_service'
import type { Actor } from '#services/actor'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

type Client = TransactionClientContract | typeof db

/** ai_tutor_time_logs.source and course_lesson_subscriptions.plan_type of console grants. */
export const AI_PRO_SOURCE = 'console_ai_pro'
const DAY_MS = 86_400_000
const MAX_LESSONS = 200

export interface AiProInput {
  user_id: number
  course_id: number
  level_name: string
  from_lesson: number
  to_lesson: number
  lesson_field: 'lesson_number' | 'lesson_order'
  minutes_per_card: number
  validity_days: number
  with_plan: boolean
  with_access: boolean
  package_name?: string | null
}

interface CardPlan {
  lesson_id: number
  lesson_no: number
  lesson_name: string
  quiz_id: number
  quiz_question_id: number
  existing_chat_id: number | null
  time_spent: number
  previous_total: number
  new_total: number
}

const toBool = (value: unknown) => value === true || value === 1 || value === '1'

/**
 * Complimentary "AI Pro": the console version of the monolith's `ai:grant-minutes` CLI
 * (app/Commands/GrantAiTutorMinutes.js), with the same three gates the app checks:
 *  1. plan flag   – an unexpired course_lesson_package_bookings row with has_ai_tutor = 1
 *                   (otherwise the app shows the paywall after lesson 2);
 *  2. lesson access – course_lesson_subscriptions so lessons 5+ unlock;
 *  3. minutes     – per LEARN_CARD/PDF question: chat total = SUM(ledger) + minutes,
 *                   time spent untouched, one ledger row each.
 * Every grant is recorded in console_ai_pro_grants so it can be extended or ended.
 * Paid access is never shortened here (that is a refund, owned by Finance).
 */
class AiProService {
  async catalog(courseId?: number) {
    if (!courseId) {
      // `courses.title` is the course name in the monolith schema (there is no `name`).
      // Only courses with live, levelled lessons can be granted.
      const courses = await db
        .from('courses')
        .whereNotNull('title')
        .whereNot('title', '')
        .whereExists((q) =>
          q.from('course_lessons as l').whereRaw('l.course_id = courses.id').where('l.is_deleted', 0).whereNotNull('l.course_level')
        )
        .select('id', 'title as name')
        .orderBy('title')
        .limit(500)
      return { courses }
    }
    const [levels, packages] = await Promise.all([
      db
        .from('course_lessons')
        .where('course_id', courseId)
        .where('is_deleted', 0)
        .whereNotNull('course_level')
        .groupBy('course_level')
        .select('course_level as level')
        .count('* as lessons')
        .min('lesson_number as first')
        .max('lesson_number as last'),
      db
        .from('course_lesson_packages')
        .where('course_id', courseId)
        .where('status', 'active')
        .where('has_ai_tutor', 1)
        .orderBy('sort_order')
        .select('id', 'name', 'ai_chat_duration', 'duration_days', 'selling_price'),
    ])
    return {
      levels: levels.map((l) => ({ level: l.level, lessons: Number(l.lessons), first: l.first, last: l.last })),
      packages,
    }
  }

  validate(input: AiProInput) {
    if (input.from_lesson > input.to_lesson) throw new ApiException(422, '“From lesson” is after “to lesson”')
    if (input.to_lesson - input.from_lesson + 1 > MAX_LESSONS) {
      throw new ApiException(422, `At most ${MAX_LESSONS} lessons per grant`)
    }
    if (!input.with_plan && !input.with_access && input.minutes_per_card === 0) {
      throw new ApiException(422, 'Nothing to grant: choose minutes, the AI plan, or lesson access')
    }
  }

  /** Dry run: exactly what a grant would write, computed the same way the CLI does. */
  async preview(input: AiProInput, client: Client = db) {
    this.validate(input)
    const user = await client.from('users').where('id', input.user_id).select('id').first()
    if (!user) throw new ApiException(404, 'Learner not found')
    const lessons = await client
      .from('course_lessons')
      .where('course_id', input.course_id)
      .where('is_deleted', 0)
      .where('course_level', input.level_name)
      .whereBetween(input.lesson_field, [input.from_lesson, input.to_lesson])
      .select('id', 'name', 'quiz_id', input.lesson_field)
      .orderBy(input.lesson_field, 'asc')
    if (!lessons.length) throw new ApiException(422, 'No lessons match this course, level and range')

    const cards: CardPlan[] = []
    let skippedNoCard = 0
    let skippedAlready = 0
    if (input.minutes_per_card > 0) {
      for (const lesson of lessons) {
        if (!lesson.quiz_id) {
          skippedNoCard++
          continue
        }
        const pdfCards = await client
          .from('quiz_questions')
          .where('quiz_id', lesson.quiz_id)
          .where('type_code', 'LEARN_CARD')
          .where('sub_type_code', 'PDF')
          .select('id')
        if (!pdfCards.length) skippedNoCard++
        for (const card of pdfCards) {
          const already = await client
            .from('ai_tutor_time_logs')
            .where('user_id', input.user_id)
            .where('quiz_question_id', card.id)
            .where('source', AI_PRO_SOURCE)
            .first()
          if (already) {
            skippedAlready++
            continue
          }
          const sum = await client
            .from('ai_tutor_time_logs')
            .where('user_id', input.user_id)
            .where('quiz_question_id', card.id)
            .sum('minutes_added as total')
          const previousTotal = Number(sum[0]?.total) || 0
          const chat = await client
            .from('ai_tutor_chats')
            .where('user_id', input.user_id)
            .where('quiz_id', lesson.quiz_id)
            .where('quiz_question_id', card.id)
            .orderBy('created_at', 'desc')
            .first()
          cards.push({
            lesson_id: lesson.id,
            lesson_no: lesson[input.lesson_field],
            lesson_name: lesson.name,
            quiz_id: lesson.quiz_id,
            quiz_question_id: card.id,
            existing_chat_id: chat?.id ?? null,
            time_spent: chat?.time_spent ?? 0,
            previous_total: previousTotal,
            new_total: previousTotal + input.minutes_per_card,
          })
        }
      }
    }

    const now = Date.now()
    const activePlan = await client
      .from('course_lesson_package_bookings')
      .where('user_id', input.user_id)
      .where('course_id', input.course_id)
      .where('level_name', input.level_name)
      .where('has_ai_tutor', 1)
      .where('expire_on', '>', now)
      .orderBy('id', 'desc')
      .first()
    let subscriptionsToCreate = 0
    if (input.with_access) {
      const active = await client
        .from('course_lesson_subscriptions')
        .where('user_id', input.user_id)
        .whereIn(
          'course_lesson_id',
          lessons.map((l) => l.id)
        )
        .where('expired_on', '>', now)
        .select('course_lesson_id')
      const covered = new Set(active.map((a) => a.course_lesson_id))
      subscriptionsToCreate = lessons.filter((l) => !covered.has(l.id)).length
    }

    const settings = await settingsService.all()
    const minutesTotal = cards.length * input.minutes_per_card
    return {
      lessons: lessons.length,
      lessonIds: lessons.map((l) => l.id as number),
      cards,
      minutesTotal,
      skippedAlready,
      skippedNoCard,
      activePlan: activePlan
        ? { id: activePlan.id, package: activePlan.package_name, expiresAt: Number(activePlan.expire_on) }
        : null,
      createsPlan: input.with_plan && !activePlan,
      subscriptionsToCreate,
      expiresAt: now + input.validity_days * DAY_MS,
      needsApproval:
        minutesTotal > settings.ai_pro_direct_max_minutes || input.validity_days > settings.ai_pro_direct_max_days,
    }
  }

  async grant(actor: Actor, input: AiProInput, reason: string) {
    const plan = await this.preview(input)
    if (!plan.cards.length && !plan.createsPlan && !plan.subscriptionsToCreate) {
      throw new ApiException(409, 'The learner already has all of this. Nothing to grant.')
    }
    if (plan.needsApproval) {
      const request = await approvalService.request(actor, {
        action: 'tutor.access.grant',
        payload: { ...input },
        summary: `AI Pro for learner #${input.user_id}: course ${input.course_id} ${input.level_name}, lessons ${input.from_lesson}–${input.to_lesson}, ${plan.minutesTotal} min, ${input.validity_days} days`,
        reason,
      })
      return { status: 'pending_approval' as const, approvalId: request.id }
    }
    const result = await db.transaction((trx) => this.apply(actor, input, reason, trx))
    return { status: 'done' as const, ...result }
  }

  /** The grant itself (also the executor of an approved request). */
  async apply(actor: Actor, input: AiProInput, reason: string, trx: TransactionClientContract, approvalId?: number) {
    await trx.from('users').where('id', input.user_id).forUpdate().first()
    // Recomputed under the lock: an approval may run days after the preview.
    const plan = await this.preview(input, trx)
    const now = Date.now()
    const nowDate = new Date(now)
    const expiresAt = now + input.validity_days * DAY_MS

    let packageBookingId: number | null = null
    if (plan.createsPlan) {
      const pkg = await trx
        .from('course_lesson_packages')
        .where('course_id', input.course_id)
        .where('has_ai_tutor', 1)
        .where('status', 'active')
        .if(input.package_name, (q) => q.where('name', input.package_name!))
        .orderBy('sort_order')
        .first()
      const [id] = await trx.table('course_lesson_package_bookings').insert({
        course_booking_id: null,
        course_lesson_package_id: pkg?.id ?? null,
        course_id: input.course_id,
        user_id: input.user_id,
        level_name: input.level_name,
        expire_on: expiresAt,
        package_name: pkg?.name ?? input.package_name ?? 'Premium',
        mrp: 0,
        selling_price: 0,
        duration_days: input.validity_days,
        total_lessons: plan.lessons,
        total_quizzes: pkg?.total_quizzes ?? 0,
        has_ai_tutor: 1,
        ai_chat_type: pkg?.ai_chat_type ?? null,
        ai_chat_duration: pkg?.ai_chat_duration ?? input.minutes_per_card,
        features: pkg?.features ? (typeof pkg.features === 'string' ? pkg.features : JSON.stringify(pkg.features)) : null,
        created_at: nowDate,
        updated_at: nowDate,
      })
      packageBookingId = id
    }

    const subscriptionIds: number[] = []
    if (input.with_access) {
      const active = await trx
        .from('course_lesson_subscriptions')
        .where('user_id', input.user_id)
        .whereIn('course_lesson_id', plan.lessonIds)
        .where('expired_on', '>', now)
        .select('course_lesson_id')
      const covered = new Set(active.map((a) => a.course_lesson_id))
      for (const lessonId of plan.lessonIds.filter((l) => !covered.has(l))) {
        const [id] = await trx.table('course_lesson_subscriptions').insert({
          course_booking_id: null,
          course_lesson_id: lessonId,
          user_id: input.user_id,
          subscribed_on: now,
          plan_type: AI_PRO_SOURCE,
          expired_on: expiresAt,
          created_at: nowDate,
          updated_at: nowDate,
        })
        subscriptionIds.push(id)
      }
    }

    const granted: { quiz_question_id: number; chat_id: number; minutes: number }[] = []
    for (const card of plan.cards) {
      let chatId = card.existing_chat_id
      if (chatId) {
        await trx
          .from('ai_tutor_chats')
          .where('id', chatId)
          .update({
            total_minutes: card.new_total,
            remaining_minutes: Math.max(0, card.new_total - card.time_spent),
            updated_at: nowDate,
          })
      } else {
        const [id] = await trx.table('ai_tutor_chats').insert({
          user_id: input.user_id,
          quiz_id: card.quiz_id,
          quiz_question_id: card.quiz_question_id,
          total_minutes: card.new_total,
          remaining_minutes: card.new_total,
          status: 'pending',
          created_at: nowDate,
          updated_at: nowDate,
        })
        chatId = id
      }
      await trx.table('ai_tutor_time_logs').insert({
        user_id: input.user_id,
        quiz_question_id: card.quiz_question_id,
        ai_tutor_chat_id: chatId,
        source: AI_PRO_SOURCE,
        minutes_added: input.minutes_per_card,
        previous_total: card.previous_total,
        new_total: card.new_total,
        created_at: nowDate,
        updated_at: nowDate,
      })
      granted.push({ quiz_question_id: card.quiz_question_id, chat_id: chatId!, minutes: input.minutes_per_card })
    }

    const [grantId] = await trx.table('console_ai_pro_grants').insert({
      user_id: input.user_id,
      course_id: input.course_id,
      level_name: input.level_name,
      from_lesson: input.from_lesson,
      to_lesson: input.to_lesson,
      lesson_field: input.lesson_field,
      minutes_per_card: input.minutes_per_card,
      validity_days: input.validity_days,
      with_plan: input.with_plan,
      with_access: input.with_access,
      package_booking_id: packageBookingId,
      cards_granted: granted.length,
      minutes_total: granted.length * input.minutes_per_card,
      subscriptions_created: subscriptionIds.length,
      subscription_ids: JSON.stringify(subscriptionIds),
      cards: JSON.stringify(granted),
      expires_at: expiresAt,
      status: 'active',
      granted_by: actor.user.id,
      approval_id: approvalId ?? null,
      reason: reason.slice(0, 500),
      created_at: nowDate,
      updated_at: nowDate,
    })

    const result = {
      grant_id: grantId as number,
      user_id: input.user_id,
      package_booking_id: packageBookingId,
      existing_plan_id: plan.activePlan?.id ?? null,
      subscriptions_created: subscriptionIds.length,
      cards_granted: granted.length,
      minutes_total: granted.length * input.minutes_per_card,
      expires_at: expiresAt,
    }
    await auditService.record(
      {
        actor,
        action: 'tutor.access.granted',
        targetType: 'learner',
        targetId: input.user_id,
        reason,
        metadata: { ...result, input: { ...input }, ...(approvalId ? { approval_id: approvalId } : {}) },
      },
      trx
    )
    return result
  }

  /** Everything that gives this learner AI tutor access, paid or not. */
  async forLearner(userId: number) {
    const now = Date.now()
    const [plans, grants, subscriptions] = await Promise.all([
      db
        .from('course_lesson_package_bookings as b')
        .leftJoin('courses as c', 'c.id', 'b.course_id')
        .where('b.user_id', userId)
        .where('b.has_ai_tutor', 1)
        .orderBy('b.id', 'desc')
        .limit(50)
        .select('b.id', 'b.course_id', 'c.title as course_name', 'b.level_name', 'b.package_name', 'b.expire_on', 'b.course_booking_id', 'b.selling_price', 'b.ai_chat_duration', 'b.created_at'),
      db
        .from('console_ai_pro_grants as g')
        .leftJoin('console_users as u', 'u.id', 'g.granted_by')
        .where('g.user_id', userId)
        .orderBy('g.id', 'desc')
        .select('g.*', 'u.name as granted_by_name'),
      db
        .from('course_lesson_subscriptions')
        .where('user_id', userId)
        .where('expired_on', '>', now)
        .count('* as total')
        .first(),
    ])
    const consoleBookings = new Set(grants.map((g) => g.package_booking_id).filter(Boolean))
    return {
      plans: plans.map((p) => ({
        id: p.id,
        courseId: p.course_id,
        course: p.course_name,
        level: p.level_name,
        package: p.package_name,
        expiresAt: Number(p.expire_on) || null,
        active: Number(p.expire_on) > now,
        kind: consoleBookings.has(p.id) ? 'console' : p.course_booking_id ? 'paid' : 'complimentary',
        aiMinutes: p.ai_chat_duration,
        createdAt: p.created_at,
      })),
      grants: grants.map((g) => ({
        id: g.id,
        courseId: g.course_id,
        level: g.level_name,
        lessons: `${g.from_lesson}–${g.to_lesson}`,
        minutesPerCard: g.minutes_per_card,
        cardsGranted: g.cards_granted,
        minutesTotal: g.minutes_total,
        subscriptionsCreated: g.subscriptions_created,
        packageBookingId: g.package_booking_id,
        expiresAt: Number(g.expires_at),
        status: g.status === 'active' && Number(g.expires_at) <= now ? 'expired' : g.status,
        grantedBy: g.granted_by_name,
        reason: g.reason,
        endReason: g.end_reason,
        createdAt: g.created_at,
      })),
      activeLessonSubscriptions: Number(subscriptions?.total ?? 0),
    }
  }

  /** Lengthens a console grant (plan + the lesson subscriptions it created). */
  async extend(actor: Actor, grantId: number, days: number, reason: string) {
    const settings = await settingsService.all()
    if (!Number.isInteger(days) || days < 1 || days > Math.max(1, settings.ai_pro_direct_max_days)) {
      throw new ApiException(
        422,
        `Extend by 1–${settings.ai_pro_direct_max_days} days. For longer, give a new grant (it goes through approval).`
      )
    }
    return db.transaction(async (trx) => {
      const grant = await this.lockGrant(trx, grantId)
      if (grant.status !== 'active') throw new ApiException(409, 'This grant has been ended')
      const before = Number(grant.expires_at)
      const after = Math.max(Date.now(), before) + days * DAY_MS
      await this.setExpiry(trx, grant, after)
      await trx.from('console_ai_pro_grants').where('id', grantId).update({ expires_at: after, updated_at: new Date() })
      await auditService.record(
        { actor, action: 'tutor.access.extended', targetType: 'learner', targetId: grant.user_id, reason, metadata: { grant_id: grantId, days, before, after } },
        trx
      )
      return { expiresAt: after }
    })
  }

  /**
   * Ends a console grant now: the plan and lesson subscriptions it created expire, and
   * (optionally) the minutes it granted that are still unused are taken back. Minutes
   * already used are never clawed back.
   */
  async end(actor: Actor, grantId: number, reason: string, removeUnusedMinutes: boolean) {
    return db.transaction(async (trx) => {
      const grant = await this.lockGrant(trx, grantId)
      if (grant.status !== 'active') throw new ApiException(409, 'This grant has already been ended')
      await trx.from('users').where('id', grant.user_id).forUpdate().first()
      const now = Date.now()
      await this.setExpiry(trx, grant, now)

      let minutesRemoved = 0
      if (removeUnusedMinutes) {
        const cards = (typeof grant.cards === 'string' ? JSON.parse(grant.cards) : grant.cards) ?? []
        for (const card of cards as { quiz_question_id: number; chat_id: number; minutes: number }[]) {
          const chat = await trx.from('ai_tutor_chats').where('id', card.chat_id).forUpdate().first()
          if (!chat) continue
          const take = Math.min(card.minutes, Math.max(0, Number(chat.remaining_minutes) || 0))
          if (take <= 0) continue
          const total = Number(chat.total_minutes) || 0
          await trx.from('ai_tutor_chats').where('id', chat.id).update({
            total_minutes: total - take,
            remaining_minutes: Math.max(0, total - take - (Number(chat.time_spent) || 0)),
            updated_at: new Date(),
          })
          await trx.table('ai_tutor_time_logs').insert({
            user_id: grant.user_id,
            quiz_question_id: card.quiz_question_id,
            ai_tutor_chat_id: chat.id,
            source: `${AI_PRO_SOURCE}_end`,
            minutes_added: -take,
            previous_total: total,
            new_total: total - take,
            created_at: new Date(),
            updated_at: new Date(),
          })
          minutesRemoved += take
        }
      }
      await trx.from('console_ai_pro_grants').where('id', grantId).update({
        status: 'ended',
        expires_at: Math.min(Number(grant.expires_at), now),
        ended_by: actor.user.id,
        ended_at: new Date(),
        end_reason: reason.slice(0, 500),
        updated_at: new Date(),
      })
      await auditService.record(
        { actor, action: 'tutor.access.ended', targetType: 'learner', targetId: grant.user_id, reason, metadata: { grant_id: grantId, minutes_removed: minutesRemoved } },
        trx
      )
      return { minutesRemoved }
    })
  }

  private async lockGrant(trx: TransactionClientContract, grantId: number) {
    const grant = await trx.from('console_ai_pro_grants').where('id', grantId).forUpdate().first()
    if (!grant) throw new ApiException(404, 'Grant not found')
    return grant
  }

  private async setExpiry(trx: TransactionClientContract, grant: Record<string, any>, expiresAt: number) {
    if (grant.package_booking_id) {
      await trx
        .from('course_lesson_package_bookings')
        .where('id', grant.package_booking_id)
        .update({ expire_on: expiresAt, updated_at: new Date() })
    }
    const ids = (typeof grant.subscription_ids === 'string' ? JSON.parse(grant.subscription_ids) : grant.subscription_ids) ?? []
    if (ids.length) {
      await trx.from('course_lesson_subscriptions').whereIn('id', ids).update({ expired_on: expiresAt, updated_at: new Date() })
    }
  }
}

export default new AiProService()

export const parseAiProInput = (raw: Record<string, unknown>): AiProInput => ({
  user_id: Number(raw.user_id),
  course_id: Number(raw.course_id),
  level_name: String(raw.level_name),
  from_lesson: Number(raw.from_lesson),
  to_lesson: Number(raw.to_lesson),
  lesson_field: raw.lesson_field === 'lesson_order' ? 'lesson_order' : 'lesson_number',
  minutes_per_card: Number(raw.minutes_per_card),
  validity_days: Number(raw.validity_days),
  with_plan: toBool(raw.with_plan),
  with_access: toBool(raw.with_access),
  package_name: raw.package_name ? String(raw.package_name) : null,
})
