import { DateTime } from 'luxon'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import auditService from '#services/audit_service'
import settingsService from '#services/settings_service'
import { isCritical } from '#rbac/permissions'

/**
 * Route-level authorisation: the actor needs every listed permission. Enforced here on
 * the server for every API route (the UI hiding a button is only a convenience).
 * Denials are audited. Critical permissions also need a recent MFA check (step-up):
 * the UI asks for a code and retries.
 */
export default class CanMiddleware {
  async handle(ctx: HttpContext, next: NextFn, permissions: string[]) {
    const { actor, request, response } = ctx
    const missing = permissions.filter((p) => !actor.permissions.has(p))
    if (missing.length) {
      await auditService.record({
        actor,
        action: 'access.denied',
        outcome: 'denied',
        metadata: { missing, route: `${request.method()} ${ctx.route?.pattern ?? request.url()}` },
      })
      return response.status(403).json({
        error: { code: 'FORBIDDEN', message: 'You don’t have access to this.', missing },
      })
    }
    if (permissions.some(isCritical)) {
      const { step_up_minutes: minutes } = await settingsService.all()
      const fresh = actor.session.mfaAt && actor.session.mfaAt.plus({ minutes }) > DateTime.now()
      if (!fresh) {
        return response.status(403).json({
          error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you: enter a code from your authenticator app.' },
        })
      }
    }
    return next()
  }
}
