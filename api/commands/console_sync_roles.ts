import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/** Writes the system roles from app/rbac/roles.ts. Run after every deploy that changes them. */
export default class ConsoleSyncRoles extends BaseCommand {
  static commandName = 'console:sync-roles'
  static description = 'Create or update the system roles and their permissions'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { default: rbacService } = await import('#services/rbac_service')
    const { SYSTEM_ROLES } = await import('#rbac/roles')
    await rbacService.syncSystemRoles()
    this.logger.success(`Synced ${SYSTEM_ROLES.length} system roles`)
  }
}
