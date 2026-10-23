import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import ConsoleRole from '#models/console_role'
import ApiException from '#exceptions/api_exception'
import auditService from '#services/audit_service'
import rbacService from '#services/rbac_service'
import { MODULES } from '#rbac/permissions'
import { reasonValidator, roleValidator } from '#validators/console'

export default class RolesController {
  /** Roles with their permissions, plus the full catalog for the permission matrix. */
  async index() {
    return { roles: await rbacService.listRoles(), modules: MODULES }
  }

  async store({ request, actor }: HttpContext) {
    const input = await request.validateUsing(roleValidator)
    const slug = rbacService.validateSlug(input.slug)
    const permissions = rbacService.validatePermissions(input.permissions)
    rbacService.assertCanGrant(actor.permissions, permissions)
    const role = await db.transaction(async (trx) => {
      const created = await rbacService.createRole(
        { slug, name: input.name, description: input.description, permissions },
        actor.user.id,
        trx
      )
      await auditService.record(
        { actor, action: 'roles.created', targetType: 'role', targetId: created.id, reason: input.reason, metadata: { slug, permissions } },
        trx
      )
      return created
    })
    return { id: role.id }
  }

  async update({ request, actor, params }: HttpContext) {
    const role = await this.customRole(Number(params.id))
    const input = await request.validateUsing(roleValidator)
    const permissions = rbacService.validatePermissions(input.permissions)
    const before = await rbacService.grantsOf([role.id])
    // Holding every permission both before and after: no widening a role beyond your own.
    rbacService.assertCanGrant(actor.permissions, [...before, ...permissions])
    await db.transaction(async (trx) => {
      await rbacService.updateRole(role, { name: input.name, description: input.description ?? null, permissions }, trx)
      await auditService.record(
        {
          actor,
          action: 'roles.updated',
          targetType: 'role',
          targetId: role.id,
          reason: input.reason,
          metadata: {
            added: permissions.filter((p) => !before.includes(p)),
            removed: before.filter((p) => !permissions.includes(p)),
          },
        },
        trx
      )
    })
    return { ok: true }
  }

  async destroy({ request, actor, params }: HttpContext) {
    const role = await this.customRole(Number(params.id))
    const { reason } = await request.validateUsing(reasonValidator)
    rbacService.assertCanGrant(actor.permissions, await rbacService.grantsOf([role.id]))
    await db.transaction(async (trx) => {
      const holders = await trx.from('console_user_roles').where('role_id', role.id).count('* as total')
      if (Number(holders[0]?.total ?? 0) > 0) {
        throw new ApiException(409, 'Remove this role from everyone who has it first.')
      }
      await trx.from('console_role_permissions').where('role_id', role.id).delete()
      await trx.from('console_roles').where('id', role.id).delete()
      await auditService.record(
        { actor, action: 'roles.deleted', targetType: 'role', targetId: role.id, reason, metadata: { slug: role.slug } },
        trx
      )
    })
    return { ok: true }
  }

  private async customRole(id: number) {
    const role = await ConsoleRole.find(id)
    if (!role) throw new ApiException(404, 'Role not found')
    if (role.isSystem) {
      throw new ApiException(403, 'System roles are defined in code. Create a custom role instead.', 'SYSTEM_ROLE')
    }
    return role
  }
}
