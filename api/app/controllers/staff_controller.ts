import type { HttpContext } from '@adonisjs/core/http'
import staffService from '#services/staff_service'
import { inviteValidator, listValidator, reasonValidator, renameValidator, rolesValidator } from '#validators/console'

export default class StaffController {
  async index({ request }: HttpContext) {
    const { q, status } = await listValidator.validate(request.qs())
    return staffService.list({ q, status })
  }

  async show({ params }: HttpContext) {
    return staffService.get(Number(params.id))
  }

  async invite({ request, actor }: HttpContext) {
    const input = await request.validateUsing(inviteValidator)
    return staffService.invite(actor, { email: input.email, name: input.name, roleIds: input.roles, reason: input.reason })
  }

  async rename({ request, actor, params }: HttpContext) {
    const { name } = await request.validateUsing(renameValidator)
    return staffService.rename(actor, Number(params.id), name)
  }

  async roles({ request, actor, params }: HttpContext) {
    const { roles, reason } = await request.validateUsing(rolesValidator)
    return staffService.setRoles(actor, Number(params.id), roles, reason)
  }

  async disable({ request, actor, params }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    return staffService.disable(actor, Number(params.id), reason)
  }

  async enable({ request, actor, params }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    return staffService.enable(actor, Number(params.id), reason)
  }

  async resetAccess({ request, actor, params }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    return staffService.resetAccess(actor, Number(params.id), reason)
  }

  async revokeSessions({ request, actor, params }: HttpContext) {
    const { reason } = await request.validateUsing(reasonValidator)
    await staffService.revokeSessions(actor, Number(params.id), reason)
    return { ok: true }
  }
}
