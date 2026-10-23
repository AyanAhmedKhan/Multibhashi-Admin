import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import ConsoleUser from '#models/console_user'
import consoleConfig from '#config/console'
import rbacService from '#services/rbac_service'
import sessionService from '#services/session_service'
import settingsService from '#services/settings_service'
import { safeEqual } from '#helpers/tokens'

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function refuse({ response }: HttpContext, status: number, code: string, message: string) {
  return response.status(status).json({ error: { code, message } })
}

/**
 * Resolves the session cookie to `ctx.actor`. Every check runs on every request:
 * session live (absolute + idle timeout), account still active, IP allowlist, and —
 * for state-changing requests — the session's CSRF token in X-CSRF-Token.
 * Permissions are re-read each request, so a role change applies immediately.
 * `pending` lets a password-verified, MFA-pending session reach the MFA endpoint only.
 */
export default class AuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { pending?: boolean } = {}) {
    const { request } = ctx
    const session = await sessionService.resolve(request.cookie(consoleConfig.cookie.session))
    if (!session) return refuse(ctx, 401, 'UNAUTHENTICATED', 'Please sign in.')
    const expected = options.pending ? 'mfa_pending' : 'active'
    if (session.state !== expected) {
      return refuse(ctx, 401, session.state === 'mfa_pending' ? 'MFA_REQUIRED' : 'UNAUTHENTICATED', 'Please sign in.')
    }
    const user = await ConsoleUser.find(session.userId)
    if (!user || user.status !== 'active') {
      await sessionService.revoke(session, 'not_active')
      return refuse(ctx, 401, 'UNAUTHENTICATED', 'Please sign in.')
    }
    const ip = request.ip()
    if (!(await settingsService.ipAllowed(ip))) {
      return refuse(ctx, 403, 'IP_NOT_ALLOWED', 'The console is not available from this network.')
    }
    if (UNSAFE.has(request.method())) {
      const token = request.header('x-csrf-token') ?? ''
      if (!safeEqual(token, session.csrfToken)) {
        return refuse(ctx, 403, 'BAD_CSRF', 'Your session token is missing or stale. Reload the page.')
      }
    }

    const { roles, permissions } = options.pending
      ? { roles: [], permissions: new Set<string>() }
      : await rbacService.permissionsOf(user.id)
    ctx.actor = {
      user,
      session,
      roles,
      permissions,
      ip,
      userAgent: request.header('user-agent') ?? null,
      requestId: request.id() ?? null,
    }
    // Background polling (dashboards refreshing themselves) must not keep an unattended
    // console signed in past the idle timeout: only real requests count as activity.
    if (request.header('x-background') !== '1') await sessionService.touch(session)
    return next()
  }
}
