import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import ConsoleUser from '#models/console_user'
import ApiException from '#exceptions/api_exception'
import consoleConfig from '#config/console'
import auditService from '#services/audit_service'
import rbacService from '#services/rbac_service'
import sessionService from '#services/session_service'
import { SUPER_ADMIN } from '#rbac/roles'
import { randomToken, sha256 } from '#helpers/tokens'
import mailService, { simpleHtml } from '#services/mail_service'
import logger from '@adonisjs/core/services/logger'
import type { Actor } from '#services/actor'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function setupLink(token: string) {
  return `${consoleConfig.origins[0]}/setup/${token}`
}

/** Emails the one-time link. A failed send never undoes the invite: the link is shown to share by hand. */
async function emailInvite(user: { name: string; email: string }, link: string, invitedBy: string) {
  const first = user.name.split(/\s+/)[0]
  try {
    await mailService.send({
      to: user.email,
      subject: 'Your invite to the MultiBhashi Admin Console',
      text: `Hi ${first},\n\n${invitedBy} invited you to the MultiBhashi Admin Console. Open this link to choose your password (it works once and expires in ${consoleConfig.setupLinkHours} hours):\n\n${link}\n`,
      html: simpleHtml({
        heading: 'You’re invited to the MultiBhashi Console',
        lines: [`Hi ${first}, ${invitedBy} invited you. Choose your password to get started. The link works once and expires in ${consoleConfig.setupLinkHours} hours.`],
        link: { href: link, label: 'Set up my account' },
      }),
    })
    return { emailed: true, emailError: null }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'invite email failed')
    return { emailed: false, emailError: (error as Error).message }
  }
}

class StaffService {
  async list(filters: { q?: string; status?: string }) {
    const query = ConsoleUser.query().orderBy('name')
    if (filters.status) query.where('status', filters.status)
    if (filters.q) {
      const like = `%${filters.q.replace(/[%_\\]/g, '\\$&')}%`
      query.where((q) => q.whereILike('name', like).orWhereILike('email', like))
    }
    const users = await query.limit(500)
    const roles = users.length
      ? await db
          .from('console_user_roles as ur')
          .join('console_roles as r', 'r.id', 'ur.role_id')
          .whereIn(
            'ur.user_id',
            users.map((u) => u.id)
          )
          .select('ur.user_id', 'r.id', 'r.slug', 'r.name')
      : []
    return users.map((user) => ({
      ...this.view(user),
      roles: roles
        .filter((r) => r.user_id === user.id)
        .map((r) => ({ id: r.id, slug: r.slug, name: r.name })),
    }))
  }

  async get(id: number) {
    const user = await ConsoleUser.find(id)
    if (!user) throw new ApiException(404, 'Staff member not found')
    const { roles, permissions } = await rbacService.permissionsOf(user.id)
    const sessions = await sessionService.listActive(user.id)
    return {
      ...this.view(user),
      roles,
      permissions: [...permissions],
      sessions: sessions.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
      })),
    }
  }

  view(user: ConsoleUser) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      mfaEnabled: !!user.mfaEnabledAt,
      lockedUntil: user.lockedUntil && user.lockedUntil > DateTime.now() ? user.lockedUntil : null,
      lastLoginAt: user.lastLoginAt,
      lastLoginIp: user.lastLoginIp,
      setupExpiresAt: user.status === 'invited' ? user.setupExpiresAt : null,
      disabledReason: user.disabledReason,
      recoveryCodesLeft: user.recoveryCodes?.length ?? 0,
      createdAt: user.createdAt,
    }
  }

  async invite(actor: Actor, input: { email: string; name: string; roleIds: number[]; reason: string; sendEmail?: boolean }) {
    const email = String(input.email ?? '').trim().toLowerCase()
    const name = String(input.name ?? '').trim()
    if (!EMAIL.test(email) || email.length > 254) throw new ApiException(422, 'Enter a valid work email')
    if (name.length < 2 || name.length > 120) throw new ApiException(422, 'Enter the person’s name')
    const roles = await rbacService.rolesByIds(input.roleIds)
    if (!roles.length) throw new ApiException(422, 'Give the new staff member at least one role')
    // Only someone holding every permission of the roles can hand them out, so only a
    // Super Admin can invite a Super Admin. Any one Super Admin may: no second approval
    // (the owners' decision, 2026-10-24); the grant is in the audit log.
    rbacService.assertCanGrant(actor.permissions, await rbacService.grantsOf(roles.map((r) => r.id)))
    const wantsSuperAdmin = roles.some((r) => r.slug === SUPER_ADMIN)
    const assigned = roles

    const token = randomToken()
    const user = await db.transaction(async (trx) => {
      if (await ConsoleUser.query({ client: trx }).where('email', email).first()) {
        throw new ApiException(409, 'A staff account with that email already exists')
      }
      const created = await ConsoleUser.create(
        {
          email,
          name,
          status: 'invited',
          setupTokenHash: sha256(token),
          setupExpiresAt: DateTime.now().plus({ hours: consoleConfig.setupLinkHours }),
          failedLogins: 0,
          createdBy: actor.user.id,
        },
        { client: trx }
      )
      await rbacService.setUserRoles(
        created.id,
        assigned.map((r) => r.id),
        actor.user.id,
        trx
      )
      await auditService.record(
        {
          actor,
          action: 'staff.invited',
          targetType: 'staff',
          targetId: created.id,
          reason: input.reason,
          metadata: { email, name, roles: assigned.map((r) => r.slug), ...(wantsSuperAdmin ? { super_admin: 'granted' } : {}) },
        },
        trx
      )
      return created
    })
    const delivery = input.sendEmail ? await emailInvite(user, setupLink(token), actor.user.name) : { emailed: false, emailError: null }
    return {
      ...delivery,
      user: this.view(user),
      setupLink: setupLink(token),
      expiresAt: user.setupExpiresAt,
      superAdmin: wantsSuperAdmin ? 'granted' : null,
      approvalId: null,
    }
  }

  /**
   * A fresh one-time setup link for someone who hasn't accepted their invite yet (lost or
   * expired link). The previous link stops working.
   */
  async reissueInvite(actor: Actor, id: number, sendEmail = false) {
    const user = await this.target(id)
    if (user.status !== 'invited') throw new ApiException(409, 'This person has already set up their account. Use “Reset access” instead.')
    await this.assertOutranks(actor, user.id)
    const token = randomToken()
    await db.transaction(async (trx) => {
      user.useTransaction(trx)
      user.merge({ setupTokenHash: sha256(token), setupExpiresAt: DateTime.now().plus({ hours: consoleConfig.setupLinkHours }), mfaPendingSecret: null })
      await user.save()
      await auditService.record({ actor, action: 'staff.invite_reissued', targetType: 'staff', targetId: id }, trx)
    })
    const delivery = sendEmail ? await emailInvite(user, setupLink(token), actor.user.name) : { emailed: false, emailError: null }
    return { ...delivery, user: this.view(user), setupLink: setupLink(token), expiresAt: user.setupExpiresAt }
  }

  async rename(actor: Actor, id: number, name: string) {
    const user = await this.target(id)
    const clean = String(name ?? '').trim()
    if (clean.length < 2 || clean.length > 120) throw new ApiException(422, 'Enter a name')
    await db.transaction(async (trx) => {
      const before = user.name
      user.useTransaction(trx)
      user.name = clean
      await user.save()
      await auditService.record(
        { actor, action: 'staff.renamed', targetType: 'staff', targetId: id, metadata: { before, after: clean } },
        trx
      )
    })
    return this.view(user)
  }

  /**
   * Replaces a staff member's roles. Rules: nobody changes their own roles; the actor
   * must hold every permission of the roles added AND removed (so only a Super Admin
   * makes someone a Super Admin, directly, without a second approval); the last active
   * super admin keeps the role.
   */
  async setRoles(actor: Actor, id: number, roleIds: number[], reason: string) {
    if (id === actor.user.id) throw new ApiException(403, 'You can’t change your own roles.', 'SELF')
    const user = await this.target(id)
    const next = await rbacService.rolesByIds(roleIds)
    const current = await rbacService.rolesOf(user.id)
    const added = next.filter((r) => !current.some((c) => c.id === r.id))
    const removed = current.filter((c) => !next.some((r) => r.id === c.id))
    if (!added.length && !removed.length) return { status: 'unchanged' as const }
    rbacService.assertCanGrant(
      actor.permissions,
      await rbacService.grantsOf([...added, ...removed].map((r) => r.id))
    )
    await db.transaction((trx) => this.applyRoles(actor, user.id, next.map((r) => r.id), reason, trx))
    return { status: 'done' as const }
  }

  /** Also the executor of an approved `console.roles.assign` request. */
  async applyRoles(
    actor: Actor,
    userId: number,
    roleIds: number[],
    reason: string,
    trx: TransactionClientContract,
    approvalId?: number
  ) {
    const user = await ConsoleUser.query({ client: trx }).where('id', userId).forUpdate().first()
    if (!user) throw new ApiException(404, 'Staff member not found')
    const before = await rbacService.rolesOf(userId, trx)
    const next = await rbacService.rolesByIds(roleIds, trx)
    const superAdminId = await rbacService.superAdminRoleId(trx)
    const losesSuperAdmin =
      before.some((r) => r.id === superAdminId) && !next.some((r) => r.id === superAdminId)
    if (losesSuperAdmin && (await rbacService.otherActiveSuperAdmins(userId, trx)) === 0) {
      throw new ApiException(409, 'There must always be at least one active Super Admin.', 'LAST_SUPER_ADMIN')
    }
    await rbacService.setUserRoles(userId, roleIds, actor.user.id, trx)
    await auditService.record(
      {
        actor,
        action: 'staff.roles_changed',
        targetType: 'staff',
        targetId: userId,
        reason,
        metadata: {
          before: before.map((r) => r.slug),
          after: next.map((r) => r.slug),
          ...(approvalId ? { approval_id: approvalId } : {}),
        },
      },
      trx
    )
  }

  async disable(actor: Actor, id: number, reason: string) {
    if (id === actor.user.id) throw new ApiException(403, 'You can’t disable your own account.', 'SELF')
    const user = await this.target(id)
    await this.assertOutranks(actor, user.id)
    await db.transaction(async (trx) => {
      const superAdminId = await rbacService.superAdminRoleId(trx)
      const roles = await rbacService.rolesOf(user.id, trx)
      if (
        roles.some((r) => r.id === superAdminId) &&
        (await rbacService.otherActiveSuperAdmins(user.id, trx)) === 0
      ) {
        throw new ApiException(409, 'There must always be at least one active Super Admin.', 'LAST_SUPER_ADMIN')
      }
      user.useTransaction(trx)
      user.merge({ status: 'disabled', disabledAt: DateTime.now(), disabledReason: reason.slice(0, 255) })
      await user.save()
      await auditService.record({ actor, action: 'staff.disabled', targetType: 'staff', targetId: id, reason }, trx)
    })
    await sessionService.revokeAllForUser(user.id, 'disabled')
    return this.view(user)
  }

  async enable(actor: Actor, id: number, reason: string) {
    const user = await this.target(id)
    if (user.status !== 'disabled') throw new ApiException(409, 'This account is not disabled')
    await this.assertOutranks(actor, user.id)
    if (!user.passwordHash || !user.mfaSecret) {
      throw new ApiException(409, 'This account never finished setup: use “Reset access” to send a new link.')
    }
    await db.transaction(async (trx) => {
      user.useTransaction(trx)
      user.merge({ status: 'active', disabledAt: null, disabledReason: null, failedLogins: 0, lockedUntil: null })
      await user.save()
      await auditService.record({ actor, action: 'staff.enabled', targetType: 'staff', targetId: id, reason }, trx)
    })
    return this.view(user)
  }

  /**
   * Lost phone / forgotten password: the account goes back to "invited" with a new
   * one-time link; password, MFA and recovery codes are wiped and every session ends.
   * Only someone holding all of the target's permissions may do it (otherwise the link
   * would hand them the account).
   */
  async resetAccess(actor: Actor, id: number, reason: string) {
    if (id === actor.user.id) {
      throw new ApiException(403, 'Ask another admin to reset your access.', 'SELF')
    }
    const user = await this.target(id)
    await this.assertOutranks(actor, user.id)
    const token = randomToken()
    await db.transaction(async (trx) => {
      user.useTransaction(trx)
      user.merge({
        status: 'invited',
        passwordHash: null,
        mfaSecret: null,
        mfaPendingSecret: null,
        mfaEnabledAt: null,
        mfaLastStep: null,
        recoveryCodes: null,
        setupTokenHash: sha256(token),
        setupExpiresAt: DateTime.now().plus({ hours: consoleConfig.setupLinkHours }),
        failedLogins: 0,
        lockedUntil: null,
        disabledAt: null,
        disabledReason: null,
      })
      await user.save()
      await auditService.record({ actor, action: 'staff.access_reset', targetType: 'staff', targetId: id, reason }, trx)
    })
    await sessionService.revokeAllForUser(user.id, 'access_reset')
    return { user: this.view(user), setupLink: setupLink(token) }
  }

  async revokeSessions(actor: Actor, id: number, reason: string) {
    const user = await this.target(id)
    if (user.id !== actor.user.id) await this.assertOutranks(actor, user.id)
    const count = await sessionService.revokeAllForUser(
      user.id,
      'revoked_by_admin',
      user.id === actor.user.id ? actor.session.id : undefined
    )
    await auditService.record({
      actor,
      action: 'staff.sessions_revoked',
      targetType: 'staff',
      targetId: id,
      reason,
      metadata: { sessions: Number(count) || 0 },
    })
  }

  private async target(id: number) {
    const user = await ConsoleUser.find(id)
    if (!user) throw new ApiException(404, 'Staff member not found')
    return user
  }

  private async assertOutranks(actor: Actor, userId: number) {
    const { roles } = await rbacService.permissionsOf(userId)
    rbacService.assertCanGrant(actor.permissions, await rbacService.grantsOf(roles.map((r) => r.id)))
  }
}

export default new StaffService()
