import db from '@adonisjs/lucid/services/db'
import ConsoleRole from '#models/console_role'
import ApiException from '#exceptions/api_exception'
import { ALL, effectivePermissions, isKnownPermission } from '#rbac/permissions'
import { SUPER_ADMIN, SYSTEM_ROLES } from '#rbac/roles'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

type Client = TransactionClientContract | typeof db

export interface RoleView {
  id: number
  slug: string
  name: string
  description: string | null
  isSystem: boolean
  permissions: string[]
  members: number
  seats?: string
  legacy?: string[]
}

const SLUG = /^[a-z][a-z0-9_]{2,47}$/

class RbacService {
  /** Writes the code-defined system roles (idempotent). Custom roles are untouched. */
  async syncSystemRoles() {
    await db.transaction(async (trx) => {
      for (const def of SYSTEM_ROLES) {
        let role = await ConsoleRole.query({ client: trx }).where('slug', def.slug).first()
        if (role && !role.isSystem) {
          throw new Error(`A custom role already uses the system slug "${def.slug}"`)
        }
        if (!role) {
          role = await ConsoleRole.create(
            { slug: def.slug, name: def.name, description: def.description, isSystem: true },
            { client: trx }
          )
        } else {
          role.useTransaction(trx)
          role.merge({ name: def.name, description: def.description })
          await role.save()
        }
        await trx.from('console_role_permissions').where('role_id', role.id).delete()
        await trx
          .table('console_role_permissions')
          .multiInsert(def.permissions.map((permission) => ({ role_id: role!.id, permission })))
      }
    })
  }

  async rolesOf(userId: number, client: Client = db) {
    return client
      .from('console_user_roles as ur')
      .join('console_roles as r', 'r.id', 'ur.role_id')
      .where('ur.user_id', userId)
      .select('r.id', 'r.slug', 'r.name')
      .orderBy('r.name') as Promise<{ id: number; slug: string; name: string }[]>
  }

  /** Raw grants of a set of roles (may contain `*`). */
  async grantsOf(roleIds: number[], client: Client = db) {
    if (!roleIds.length) return [] as string[]
    const rows = await client
      .from('console_role_permissions')
      .whereIn('role_id', roleIds)
      .select('permission')
    return rows.map((row: { permission: string }) => row.permission)
  }

  async permissionsOf(userId: number, client: Client = db) {
    const roles = await this.rolesOf(userId, client)
    const grants = await this.grantsOf(
      roles.map((r) => r.id),
      client
    )
    return { roles, permissions: effectivePermissions(grants) }
  }

  async listRoles(): Promise<RoleView[]> {
    const roles = await ConsoleRole.query().orderBy('is_system', 'desc').orderBy('name')
    const grants = await db.from('console_role_permissions').select('role_id', 'permission')
    const members = await db
      .from('console_user_roles as ur')
      .join('console_users as u', 'u.id', 'ur.user_id')
      .whereNot('u.status', 'disabled')
      .groupBy('ur.role_id')
      .select('ur.role_id')
      .count('* as total')
    const defs = new Map(SYSTEM_ROLES.map((r) => [r.slug, r]))
    return roles.map((role) => {
      const raw = grants.filter((g) => g.role_id === role.id).map((g) => g.permission as string)
      const def = defs.get(role.slug)
      return {
        id: role.id,
        slug: role.slug,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        permissions: [...effectivePermissions(raw)],
        members: Number(members.find((m) => m.role_id === role.id)?.total ?? 0),
        ...(role.isSystem && def ? { seats: def.seats, legacy: def.legacy } : {}),
      }
    })
  }

  /**
   * No privilege escalation: a staff member may only hand out permissions they hold
   * themselves (super admins hold all).
   */
  assertCanGrant(actorPermissions: Set<string>, permissions: Iterable<string>) {
    const missing = [...effectivePermissions(permissions)].filter((p) => !actorPermissions.has(p))
    if (missing.length) {
      throw new ApiException(
        403,
        `You can’t grant permissions you don’t have: ${missing.slice(0, 5).join(', ')}`,
        'ESCALATION'
      )
    }
  }

  validatePermissions(permissions: unknown): string[] {
    if (!Array.isArray(permissions) || !permissions.length) {
      throw new ApiException(422, 'Choose at least one permission')
    }
    const unique = [...new Set(permissions.map(String))]
    const unknown = unique.filter((p) => p === ALL || !isKnownPermission(p))
    if (unknown.length) throw new ApiException(422, `Unknown permissions: ${unknown.join(', ')}`)
    return unique.sort()
  }

  validateSlug(slug: unknown) {
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
      throw new ApiException(422, 'Slug: 3–48 lower-case letters, digits or _ (starting with a letter)')
    }
    if (SYSTEM_ROLES.some((r) => r.slug === slug)) {
      throw new ApiException(422, 'That slug belongs to a system role')
    }
    return slug
  }

  async createRole(
    input: { slug: string; name: string; description?: string | null; permissions: string[] },
    createdBy: number,
    trx: TransactionClientContract
  ) {
    if (await ConsoleRole.query({ client: trx }).where('slug', input.slug).first()) {
      throw new ApiException(409, 'A role with that slug already exists')
    }
    const role = await ConsoleRole.create(
      {
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        isSystem: false,
        createdBy,
      },
      { client: trx }
    )
    await trx
      .table('console_role_permissions')
      .multiInsert(input.permissions.map((permission) => ({ role_id: role.id, permission })))
    return role
  }

  async updateRole(
    role: ConsoleRole,
    input: { name?: string; description?: string | null; permissions?: string[] },
    trx: TransactionClientContract
  ) {
    role.useTransaction(trx)
    role.merge({
      ...(input.name ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    await role.save()
    if (input.permissions) {
      await trx.from('console_role_permissions').where('role_id', role.id).delete()
      await trx
        .table('console_role_permissions')
        .multiInsert(input.permissions.map((permission) => ({ role_id: role.id, permission })))
    }
  }

  async superAdminRoleId(client: Client = db) {
    const row = await client.from('console_roles').where('slug', SUPER_ADMIN).first()
    return row?.id as number | undefined
  }

  /** Active super admins other than `exceptUserId`, read under the caller's transaction. */
  async otherActiveSuperAdmins(exceptUserId: number, trx: TransactionClientContract) {
    const roleId = await this.superAdminRoleId(trx)
    if (!roleId) return 0
    const rows = await trx
      .from('console_user_roles as ur')
      .join('console_users as u', 'u.id', 'ur.user_id')
      .where('ur.role_id', roleId)
      .where('u.status', 'active')
      .whereNot('u.id', exceptUserId)
      .count('* as total')
    return Number(rows[0]?.total ?? 0)
  }

  /** Replaces a user's roles. Guards (escalation, last super admin) are the caller's job. */
  async setUserRoles(
    userId: number,
    roleIds: number[],
    grantedBy: number,
    trx: TransactionClientContract
  ) {
    await trx.from('console_user_roles').where('user_id', userId).delete()
    if (roleIds.length) {
      const now = new Date()
      await trx.table('console_user_roles').multiInsert(
        [...new Set(roleIds)].map((roleId) => ({
          user_id: userId,
          role_id: roleId,
          granted_by: grantedBy,
          created_at: now,
        }))
      )
    }
  }

  async rolesByIds(roleIds: unknown, client: Client = db) {
    if (!Array.isArray(roleIds)) throw new ApiException(422, 'roles must be a list of role ids')
    const ids = [...new Set(roleIds.map(Number))].filter(Number.isInteger)
    if (!ids.length) return []
    const roles = await client.from('console_roles').whereIn('id', ids).select('id', 'slug', 'name')
    if (roles.length !== ids.length) throw new ApiException(422, 'Unknown role in the list')
    return roles as { id: number; slug: string; name: string }[]
  }
}

export default new RbacService()
