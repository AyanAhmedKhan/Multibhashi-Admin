import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import consoleConfig from '#config/console'
import authService from '#services/auth_service'
import sessionService from '#services/session_service'
import settingsService from '#services/settings_service'
import approvalService from '#services/approval_service'
import auditService from '#services/audit_service'
import staffService from '#services/staff_service'
import { MODULES } from '#rbac/permissions'
import {
  changePasswordValidator,
  codeValidator,
  loginValidator,
  setupValidator,
} from '#validators/console'
import type ConsoleSession from '#models/console_session'

function setSessionCookie({ response }: HttpContext, token: string, session: ConsoleSession) {
  response.cookie(consoleConfig.cookie.session, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: app.inProduction,
    path: '/',
    maxAge: Math.max(60, Math.floor((session.expiresAt.toMillis() - Date.now()) / 1000)),
  })
}

function meta({ request }: HttpContext) {
  return { ip: request.ip(), userAgent: request.header('user-agent') ?? null }
}

export default class AuthController {
  async login(ctx: HttpContext) {
    const { email, password } = await ctx.request.validateUsing(loginValidator)
    const { token, session } = await authService.login(email, password, meta(ctx))
    setSessionCookie(ctx, token, session)
    // The MFA step is a state-changing request too, so it carries this session's token.
    return { next: 'mfa', csrfToken: session.csrfToken }
  }

  async mfa(ctx: HttpContext) {
    const { code } = await ctx.request.validateUsing(codeValidator)
    const { token, session } = await authService.completeMfa(ctx.actor.session, code, meta(ctx))
    setSessionCookie(ctx, token, session)
    return { next: 'app' }
  }

  async logout(ctx: HttpContext) {
    await sessionService.revoke(ctx.actor.session, 'signed_out')
    await auditService.record({ actor: ctx.actor, action: 'auth.logout' })
    ctx.response.clearCookie(consoleConfig.cookie.session)
    return { ok: true }
  }

  /** Who am I, what may I do, and the CSRF token for this session. */
  async me({ actor }: HttpContext) {
    const settings = await settingsService.all()
    return {
      user: staffService.view(actor.user),
      roles: actor.roles,
      permissions: [...actor.permissions].sort(),
      csrfToken: actor.session.csrfToken,
      session: {
        id: actor.session.id,
        expiresAt: actor.session.expiresAt,
        mfaAt: actor.session.mfaAt,
      },
      policy: {
        stepUpMinutes: settings.step_up_minutes,
        idleMinutes: settings.session_idle_minutes,
        grantDirectLimit: settings.grant_minutes_direct_limit,
        grantMax: settings.grant_minutes_max,
        aiProMaxDays: settings.ai_pro_direct_max_days,
        aiProMaxMinutes: settings.ai_pro_direct_max_minutes,
      },
      modules: MODULES.map((m) => ({ key: m.key, label: m.label, phase: m.phase })),
      pendingApprovals: actor.permissions.has('console.approvals.decide') ? await approvalService.pendingCount() : 0,
    }
  }

  async stepUp(ctx: HttpContext) {
    const { code } = await ctx.request.validateUsing(codeValidator)
    await authService.stepUp(ctx.actor, code)
    return { ok: true, mfaAt: ctx.actor.session.mfaAt }
  }

  async setupInfo({ params }: HttpContext) {
    return authService.setupInfo(params.token)
  }

  async completeSetup(ctx: HttpContext) {
    const { password, code } = await ctx.request.validateUsing(setupValidator)
    const recoveryCodes = await authService.completeSetup(ctx.params.token, password, code, meta(ctx))
    return { recoveryCodes }
  }

  async changePassword(ctx: HttpContext) {
    const { current, password } = await ctx.request.validateUsing(changePasswordValidator)
    await authService.changePassword(ctx.actor, current, password)
    return { ok: true }
  }

  async recoveryCodes({ actor }: HttpContext) {
    return { recoveryCodes: await authService.regenerateRecoveryCodes(actor) }
  }

  async sessions({ actor }: HttpContext) {
    const sessions = await sessionService.listActive(actor.user.id)
    return sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      current: s.id === actor.session.id,
    }))
  }

  async revokeOtherSessions({ actor }: HttpContext) {
    const count = await sessionService.revokeAllForUser(actor.user.id, 'signed_out_elsewhere', actor.session.id)
    await auditService.record({ actor, action: 'auth.other_sessions_revoked', metadata: { sessions: Number(count) || 0 } })
    return { ok: true }
  }
}
