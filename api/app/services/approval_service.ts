import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import ConsoleApprovalRequest, { type ApprovalStatus } from '#models/console_approval_request'
import ConsoleUser from '#models/console_user'
import ApiException from '#exceptions/api_exception'
import consoleConfig from '#config/console'
import auditService from '#services/audit_service'
import { SUPER_ADMIN } from '#rbac/roles'
import type { Actor } from '#services/actor'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

interface ActionDef {
  /** The approver must hold one of these too (as well as console.approvals.decide). */
  permissions: string[]
  /** …and, for access changes, this role. */
  role?: string
  execute: (
    approver: Actor,
    request: ConsoleApprovalRequest,
    trx: TransactionClientContract
  ) => Promise<Record<string, unknown>>
}

/**
 * Actions that can wait for a second pair of eyes. Executors are imported lazily: the
 * services that raise requests are the same ones that run them.
 */
const ACTIONS: Record<string, ActionDef> = {
  'tutor.minutes.grant': {
    permissions: ['tutor.minutes.grant'],
    async execute(approver, request, trx) {
      const { default: minutesService } = await import('#services/tutor/minutes_service')
      const payload = request.payload as { chat_id: number; minutes: number }
      return minutesService.applyGrant(approver, payload, request.requestReason, trx, request.id)
    },
  },
  // Comps are lost revenue: whoever may end them (Finance) may approve them too.
  'tutor.access.grant': {
    permissions: ['tutor.access.grant', 'tutor.access.revoke'],
    async execute(approver, request, trx) {
      const { default: aiProService, parseAiProInput } = await import('#services/tutor/ai_pro_service')
      return aiProService.apply(approver, parseAiProInput(request.payload), request.requestReason, trx, request.id)
    },
  },
  // No longer raised (any one Super Admin now grants Super Admin directly, 2026-10-24);
  // kept so requests created before can still be approved or rejected.
  'console.roles.assign': {
    permissions: ['console.staff.manage'],
    role: SUPER_ADMIN,
    async execute(approver, request, trx) {
      const { default: staffService } = await import('#services/staff_service')
      const payload = request.payload as { user_id: number; role_ids: number[] }
      await staffService.applyRoles(approver, payload.user_id, payload.role_ids, request.requestReason, trx, request.id)
      return { user_id: payload.user_id }
    },
  },
}

class ApprovalService {
  async request(
    actor: Actor,
    input: { action: string; payload: Record<string, unknown>; summary: string; reason: string }
  ) {
    if (!ACTIONS[input.action]) throw new Error(`No approval flow for ${input.action}`)
    return db.transaction(async (trx) => {
      const request = await ConsoleApprovalRequest.create(
        {
          action: input.action,
          payload: input.payload,
          summary: input.summary.slice(0, 255),
          status: 'pending',
          requestedBy: actor.user.id,
          requestReason: input.reason.slice(0, 500),
          expiresAt: DateTime.now().plus({ hours: consoleConfig.approvalHours }),
        },
        { client: trx }
      )
      await auditService.record(
        {
          actor,
          action: 'approval.requested',
          targetType: 'approval',
          targetId: request.id,
          reason: input.reason,
          metadata: { action: input.action, payload: input.payload, summary: input.summary },
        },
        trx
      )
      return request
    })
  }

  /** All requests for deciders; only their own for everyone else. */
  async list(status?: string, onlyRequestedBy?: number) {
    await this.expireStale()
    const query = ConsoleApprovalRequest.query().orderBy('id', 'desc').limit(200)
    if (status) query.where('status', status)
    if (onlyRequestedBy) query.where('requested_by', onlyRequestedBy)
    const requests = await query
    const ids = [...new Set(requests.flatMap((r) => [r.requestedBy, r.decidedBy]).filter(Boolean))]
    const people = ids.length
      ? await ConsoleUser.query().whereIn('id', ids as number[]).select('id', 'name', 'email')
      : []
    const who = (id: number | null) => {
      const person = people.find((p) => p.id === id)
      return person ? { id: person.id, name: person.name, email: person.email } : null
    }
    return requests.map((r) => ({
      id: r.id,
      action: r.action,
      summary: r.summary,
      payload: r.payload,
      status: r.status,
      requestedBy: who(r.requestedBy),
      requestReason: r.requestReason,
      decidedBy: who(r.decidedBy),
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      executedAt: r.executedAt,
      result: r.result,
      error: r.error,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      requiredPermissions: ACTIONS[r.action]?.permissions ?? [],
      requiredRole: ACTIONS[r.action]?.role ?? null,
    }))
  }

  async pendingCount() {
    await this.expireStale()
    const rows = await db.from('console_approval_requests').where('status', 'pending').count('* as total')
    return Number(rows[0]?.total ?? 0)
  }

  async decide(actor: Actor, id: number, approve: boolean, note: string) {
    try {
      return await db.transaction(async (trx) => {
        const request = await ConsoleApprovalRequest.query({ client: trx }).where('id', id).forUpdate().first()
        if (!request) throw new ApiException(404, 'Request not found')
        if (request.status !== 'pending') throw new ApiException(409, `This request is already ${request.status}`)
        if (request.expiresAt <= DateTime.now()) {
          request.useTransaction(trx)
          request.status = 'expired'
          await request.save()
          throw new ApiException(409, 'This request has expired')
        }
        if (request.requestedBy === actor.user.id) {
          throw new ApiException(403, 'Someone else has to decide on your own request.', 'SELF')
        }
        const def = ACTIONS[request.action]
        if (!def) throw new ApiException(409, 'This kind of request can no longer be approved')
        if (!def.permissions.some((p) => actor.permissions.has(p))) {
          throw new ApiException(403, `Deciding this needs one of: ${def.permissions.join(', ')}.`, 'FORBIDDEN')
        }
        if (def.role && !actor.roles.some((r) => r.slug === def.role)) {
          throw new ApiException(403, 'Only a Super Admin can decide this request.', 'FORBIDDEN')
        }

        request.useTransaction(trx)
        request.merge({ decidedBy: actor.user.id, decidedAt: DateTime.now(), decisionNote: note.slice(0, 500) })
        if (!approve) {
          request.status = 'rejected'
          await request.save()
          await auditService.record(
            { actor, action: 'approval.rejected', targetType: 'approval', targetId: id, reason: note, metadata: { action: request.action } },
            trx
          )
          return { status: request.status as ApprovalStatus }
        }

        const result = await def.execute(actor, request, trx)
        request.merge({ status: 'approved', executedAt: DateTime.now(), result })
        await request.save()
        await auditService.record(
          { actor, action: 'approval.approved', targetType: 'approval', targetId: id, reason: note, metadata: { action: request.action, result } },
          trx
        )
        return { status: request.status as ApprovalStatus, result }
      })
    } catch (error) {
      // The action itself failed (e.g. the class is gone): close the request as failed
      // so it can't be retried blindly, and record why.
      if (approve && error instanceof ApiException && ![403, 404, 409].includes(error.status)) {
        await this.markFailed(actor, id, error.message)
      }
      throw error
    }
  }

  async cancel(actor: Actor, id: number) {
    await db.transaction(async (trx) => {
      const request = await ConsoleApprovalRequest.query({ client: trx }).where('id', id).forUpdate().first()
      if (!request) throw new ApiException(404, 'Request not found')
      if (request.requestedBy !== actor.user.id) throw new ApiException(403, 'Only the requester can cancel it')
      if (request.status !== 'pending') throw new ApiException(409, `This request is already ${request.status}`)
      request.useTransaction(trx)
      request.status = 'cancelled'
      await request.save()
      await auditService.record({ actor, action: 'approval.cancelled', targetType: 'approval', targetId: id }, trx)
    })
  }

  private async markFailed(actor: Actor, id: number, message: string) {
    await db.transaction(async (trx) => {
      await trx
        .from('console_approval_requests')
        .where('id', id)
        .where('status', 'pending')
        .update({ status: 'failed', error: message.slice(0, 500), decided_by: actor.user.id, decided_at: new Date(), updated_at: new Date() })
      await auditService.record(
        { actor, action: 'approval.approved', outcome: 'failure', targetType: 'approval', targetId: id, reason: message },
        trx
      )
    })
  }

  private async expireStale() {
    await db
      .from('console_approval_requests')
      .where('status', 'pending')
      .where('expires_at', '<=', new Date())
      .update({ status: 'expired', updated_at: new Date() })
  }
}

export default new ApprovalService()
