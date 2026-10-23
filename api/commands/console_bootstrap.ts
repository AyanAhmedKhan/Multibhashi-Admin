import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Creates the first Super Admin (an invite: they set their own password and MFA from
 * the printed link). Refuses once an active Super Admin exists: from then on, staff are
 * invited from the console, where it is audited and needs approval.
 */
export default class ConsoleBootstrap extends BaseCommand {
  static commandName = 'console:bootstrap'
  static description = 'Invite the first Super Admin (only while there is none)'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Work email of the first Super Admin', required: true })
  declare email: string

  @flags.string({ description: 'Their name', required: true })
  declare name: string

  async run() {
    const { DateTime } = await import('luxon')
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const { default: ConsoleUser } = await import('#models/console_user')
    const { default: rbacService } = await import('#services/rbac_service')
    const { default: auditService } = await import('#services/audit_service')
    const { default: consoleConfig } = await import('#config/console')
    const { randomToken, sha256 } = await import('#helpers/tokens')

    await rbacService.syncSystemRoles()
    const roleId = await rbacService.superAdminRoleId()
    const existing = await db
      .from('console_user_roles as ur')
      .join('console_users as u', 'u.id', 'ur.user_id')
      .where('ur.role_id', roleId!)
      .whereIn('u.status', ['active', 'invited'])
      .count('* as total')
    if (Number(existing[0]?.total ?? 0) > 0) {
      this.logger.error('A Super Admin already exists. Invite people from the console instead.')
      this.exitCode = 1
      return
    }

    const email = this.email.trim().toLowerCase()
    const token = randomToken()
    await db.transaction(async (trx) => {
      if (await ConsoleUser.query({ client: trx }).where('email', email).first()) {
        throw new Error(`${email} already has a console account`)
      }
      const user = await ConsoleUser.create(
        {
          email,
          name: this.name.trim(),
          status: 'invited',
          setupTokenHash: sha256(token),
          setupExpiresAt: DateTime.now().plus({ hours: consoleConfig.setupLinkHours }),
          failedLogins: 0,
        },
        { client: trx }
      )
      await rbacService.setUserRoles(user.id, [roleId!], user.id, trx)
      await auditService.record(
        { actorEmail: 'cli', action: 'staff.bootstrapped', targetType: 'staff', targetId: user.id, metadata: { email } },
        trx
      )
    })
    this.logger.success(`Invited ${email} as Super Admin. Send them this one-time link (valid ${consoleConfig.setupLinkHours} h):`)
    this.logger.log(`${consoleConfig.origins[0]}/setup/${token}`)
  }
}
