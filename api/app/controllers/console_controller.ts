import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import approvalService from '#services/approval_service'
import auditService from '#services/audit_service'
import healthService from '#services/health_service'
import settingsService from '#services/settings_service'
import { decisionValidator, listValidator, settingsValidator } from '#validators/console'

/** Approvals, audit log, security settings and system health. */
export default class ConsoleController {
  async approvals({ request, actor }: HttpContext) {
    const { status } = await listValidator.validate(request.qs())
    const decider = actor.permissions.has('console.approvals.decide')
    return approvalService.list(status, decider ? undefined : actor.user.id)
  }

  async decide({ request, actor, params }: HttpContext) {
    const { decision, note } = await request.validateUsing(decisionValidator)
    return approvalService.decide(actor, Number(params.id), decision === 'approve', note)
  }

  async cancelApproval({ actor, params }: HttpContext) {
    await approvalService.cancel(actor, Number(params.id))
    return { ok: true }
  }

  async audit({ request }: HttpContext) {
    const f = await listValidator.validate(request.qs())
    const query = db
      .from('console_audit_logs')
      .select('id', 'created_at', 'actor_id', 'actor_email', 'action', 'target_type', 'target_id', 'outcome', 'reason', 'metadata', 'ip')
      .orderBy('id', 'desc')
    if (f.action) query.where('action', 'like', `${f.action.replace(/[%_\\]/g, '\\$&')}%`)
    if (f.actorId) query.where('actor_id', f.actorId)
    if (f.targetType) query.where('target_type', f.targetType)
    if (f.targetId) query.where('target_id', f.targetId)
    if (f.outcome) query.where('outcome', f.outcome)
    if (f.from) query.where('created_at', '>=', f.from)
    if (f.to) query.where('created_at', '<', new Date(f.to.getTime() + 86400_000))
    if (f.q) {
      const like = `%${f.q.replace(/[%_\\]/g, '\\$&')}%`
      query.where((w) => w.whereILike('actor_email', like).orWhereILike('reason', like).orWhere('target_id', f.q!))
    }
    const page = await query.paginate(f.page ?? 1, f.perPage ?? 50)
    const json = page.toJSON()
    return {
      ...json,
      data: json.data.map((row) => ({
        ...row,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      })),
    }
  }

  async verifyAudit({ actor }: HttpContext) {
    const result = await auditService.verify()
    await auditService.record({ actor, action: 'audit.verified', outcome: result.ok ? 'success' : 'failure', metadata: result })
    return result
  }

  async settings() {
    return settingsService.all()
  }

  async updateSettings({ request, actor }: HttpContext) {
    const { changes, reason } = await request.validateUsing(settingsValidator)
    await db.transaction(async (trx) => {
      const before = await settingsService.update(changes, actor.user.id, trx)
      await auditService.record({ actor, action: 'settings.updated', reason, metadata: { before, after: changes } }, trx)
    })
    return settingsService.all()
  }

  async health() {
    return { checks: await healthService.checks(), time: new Date() }
  }
}
