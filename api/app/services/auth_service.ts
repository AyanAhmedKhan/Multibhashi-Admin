import { DateTime } from 'luxon'
import hash from '@adonisjs/core/services/hash'
import encryption from '@adonisjs/core/services/encryption'
import db from '@adonisjs/lucid/services/db'
import ConsoleUser from '#models/console_user'
import type ConsoleSession from '#models/console_session'
import ApiException from '#exceptions/api_exception'
import consoleConfig from '#config/console'
import auditService from '#services/audit_service'
import sessionService, { type ClientMeta } from '#services/session_service'
import settingsService from '#services/settings_service'
import { FixedWindowLimiter } from '#helpers/rate_limiter'
import { passwordProblem } from '#helpers/password_policy'
import { normaliseRecoveryCode, recoveryCode, sha256 } from '#helpers/tokens'
import { generateSecret, otpauthUri, verifyTotp } from '#helpers/totp'
import type { Actor } from '#services/actor'

/** One message for every failed sign-in: no hint whether the email exists. */
const BAD_LOGIN = 'Wrong email or password.'
const IP_LIMIT = { limit: 30, windowMs: 15 * 60_000 }
const UNKNOWN_EMAIL_LIMIT = { limit: 5, windowMs: 15 * 60_000 }
const MFA_ATTEMPTS_PER_SESSION = 5

const limiter = new FixedWindowLimiter()
const mfaAttempts = new Map<number, number>()

/** Verifying against a fixed hash keeps unknown emails as slow as known ones. */
let dummyHash: string | null = null
async function burnHashTime(password: string) {
  dummyHash ??= await hash.make('not-a-real-password-just-timing')
  await hash.verify(dummyHash, password)
}

function lockedMessage(until: DateTime) {
  const minutes = Math.max(1, Math.ceil(until.diffNow('minutes').minutes))
  return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

class AuthService {
  async login(emailInput: string, password: string, meta: ClientMeta) {
    const email = emailInput.trim().toLowerCase()
    const ipHit = limiter.hit(`ip:${meta.ip}`, IP_LIMIT.limit, IP_LIMIT.windowMs)
    if (!ipHit.allowed) {
      throw new ApiException(429, 'Too many sign-in attempts from this network. Try again later.', 'RATE_LIMITED')
    }
    if (!(await settingsService.ipAllowed(meta.ip))) {
      await auditService.record({ actorEmail: email, action: 'auth.login', outcome: 'denied', reason: 'ip_not_allowed', ...meta })
      throw new ApiException(403, 'Sign-in is not allowed from this network.', 'IP_NOT_ALLOWED')
    }

    const user = await ConsoleUser.query().where('email', email).first()
    if (!user) {
      await burnHashTime(password)
      const hit = limiter.hit(`email:${email}`, UNKNOWN_EMAIL_LIMIT.limit, UNKNOWN_EMAIL_LIMIT.windowMs)
      await auditService.record({ actorEmail: email, action: 'auth.login', outcome: 'denied', reason: 'unknown_email', ...meta })
      if (!hit.allowed) {
        throw new ApiException(423, lockedMessage(DateTime.now().plus({ milliseconds: hit.retryAfterMs })), 'LOCKED')
      }
      throw new ApiException(401, BAD_LOGIN, 'BAD_CREDENTIALS')
    }

    if (user.lockedUntil && user.lockedUntil > DateTime.now()) {
      await burnHashTime(password)
      await auditService.record({ actorId: user.id, actorEmail: email, action: 'auth.login', outcome: 'denied', reason: 'locked', ...meta })
      throw new ApiException(423, lockedMessage(user.lockedUntil), 'LOCKED')
    }

    const passwordOk = user.passwordHash ? await hash.verify(user.passwordHash, password) : false
    if (!passwordOk) {
      await burnHashTime(password)
      await this.countFailure(user, 'bad_password', meta)
      throw new ApiException(401, BAD_LOGIN, 'BAD_CREDENTIALS')
    }
    if (user.status !== 'active' || !user.mfaSecret) {
      await auditService.record({ actorId: user.id, actorEmail: email, action: 'auth.login', outcome: 'denied', reason: `status_${user.status}`, ...meta })
      throw new ApiException(401, BAD_LOGIN, 'BAD_CREDENTIALS')
    }

    user.failedLogins = 0
    user.lockedUntil = null
    await user.save()
    return sessionService.create(user.id, 'mfa_pending', meta)
  }

  /** Second step of sign-in. Returns the new (rotated) active session. */
  async completeMfa(pending: ConsoleSession, code: string, meta: ClientMeta) {
    const user = await ConsoleUser.findOrFail(pending.userId)
    if (user.status !== 'active') {
      await sessionService.revoke(pending, 'not_active')
      throw new ApiException(401, 'Your account is not active.', 'NOT_ACTIVE')
    }
    const method = await this.checkSecondFactor(user, code)
    if (!method) {
      const attempts = (mfaAttempts.get(pending.id) ?? 0) + 1
      mfaAttempts.set(pending.id, attempts)
      await this.countFailure(user, 'bad_mfa_code', meta)
      if (attempts >= MFA_ATTEMPTS_PER_SESSION) {
        mfaAttempts.delete(pending.id)
        await sessionService.revoke(pending, 'mfa_failed')
        throw new ApiException(401, 'Too many wrong codes. Sign in again.', 'MFA_RESTART')
      }
      throw new ApiException(401, 'That code is not right. Check your authenticator app.', 'BAD_MFA')
    }
    mfaAttempts.delete(pending.id)
    user.failedLogins = 0
    user.lastLoginAt = DateTime.now()
    user.lastLoginIp = meta.ip
    await user.save()
    const result = await sessionService.activate(pending, meta)
    await auditService.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.login',
      metadata: { method, session_id: result.session.id },
      ...meta,
    })
    return result
  }

  /** Fresh MFA proof for critical actions ("sudo mode"). */
  async stepUp(actor: Actor, code: string) {
    const method = await this.checkSecondFactor(actor.user, code)
    if (!method) {
      await this.countFailure(actor.user, 'bad_step_up_code', actor)
      throw new ApiException(401, 'That code is not right.', 'BAD_MFA')
    }
    actor.session.mfaAt = DateTime.now()
    await actor.session.save()
    await auditService.record({ actor, action: 'auth.step_up', metadata: { method } })
  }

  async setupInfo(token: string) {
    const user = await this.userForSetupToken(token)
    if (!user.mfaPendingSecret) {
      user.mfaPendingSecret = encryption.encrypt(generateSecret())
      await user.save()
    }
    const secret = encryption.decrypt<string>(user.mfaPendingSecret)!
    return {
      email: user.email,
      name: user.name,
      secret,
      otpauthUri: otpauthUri(secret, user.email),
      passwordMin: consoleConfig.password.min,
    }
  }

  /** Accepts an invite / access reset: password + confirmed MFA. Returns recovery codes once. */
  async completeSetup(token: string, password: string, code: string, meta: ClientMeta) {
    const user = await this.userForSetupToken(token)
    const problem = passwordProblem(password, user)
    if (problem) throw new ApiException(422, problem, 'WEAK_PASSWORD')
    if (!user.mfaPendingSecret) throw new ApiException(409, 'Reload the page and scan the QR code again.')
    const secret = encryption.decrypt<string>(user.mfaPendingSecret)!
    const step = verifyTotp(secret, code)
    if (step === null) throw new ApiException(401, 'That code is not right. Check your authenticator app.', 'BAD_MFA')

    const codes = Array.from({ length: consoleConfig.recoveryCodes }, recoveryCode)
    await db.transaction(async (trx) => {
      user.useTransaction(trx)
      user.merge({
        passwordHash: await hash.make(password),
        passwordChangedAt: DateTime.now(),
        mfaSecret: user.mfaPendingSecret,
        mfaPendingSecret: null,
        mfaEnabledAt: DateTime.now(),
        mfaLastStep: step,
        recoveryCodes: codes.map((c) => sha256(normaliseRecoveryCode(c))),
        setupTokenHash: null,
        setupExpiresAt: null,
        status: 'active',
        failedLogins: 0,
        lockedUntil: null,
      })
      await user.save()
      await auditService.record(
        { actorId: user.id, actorEmail: user.email, action: 'staff.setup_completed', targetType: 'staff', targetId: user.id, ...meta },
        trx
      )
    })
    return codes
  }

  async changePassword(actor: Actor, current: string, next: string) {
    const user = actor.user
    if (!user.passwordHash || !(await hash.verify(user.passwordHash, current))) {
      await this.countFailure(user, 'bad_current_password', actor)
      throw new ApiException(401, 'Your current password is not right.', 'BAD_CREDENTIALS')
    }
    const problem = passwordProblem(next, user)
    if (problem) throw new ApiException(422, problem, 'WEAK_PASSWORD')
    if (await hash.verify(user.passwordHash, next)) {
      throw new ApiException(422, 'Choose a password you haven’t used here.', 'WEAK_PASSWORD')
    }
    await db.transaction(async (trx) => {
      user.useTransaction(trx)
      user.passwordHash = await hash.make(next)
      user.passwordChangedAt = DateTime.now()
      await user.save()
      await auditService.record({ actor, action: 'auth.password_changed', targetType: 'staff', targetId: user.id }, trx)
    })
    await sessionService.revokeAllForUser(user.id, 'password_changed', actor.session.id)
  }

  async regenerateRecoveryCodes(actor: Actor) {
    const codes = Array.from({ length: consoleConfig.recoveryCodes }, recoveryCode)
    await db.transaction(async (trx) => {
      actor.user.useTransaction(trx)
      actor.user.recoveryCodes = codes.map((c) => sha256(normaliseRecoveryCode(c)))
      await actor.user.save()
      await auditService.record({ actor, action: 'auth.recovery_codes_regenerated', targetType: 'staff', targetId: actor.user.id }, trx)
    })
    return codes
  }

  /** 'totp' | 'recovery_code' when the code is valid (and consumes it), else null. */
  private async checkSecondFactor(user: ConsoleUser, code: string) {
    if (!user.mfaSecret || typeof code !== 'string') return null
    const secret = encryption.decrypt<string>(user.mfaSecret)
    if (!secret) return null
    const step = verifyTotp(secret, code)
    if (step !== null) {
      // Each code works once: a step not newer than the last accepted one is a replay.
      if (user.mfaLastStep !== null && step <= user.mfaLastStep) return null
      user.mfaLastStep = step
      await user.save()
      return 'totp' as const
    }
    const normalised = normaliseRecoveryCode(code)
    if (normalised.length !== 10) return null
    const hashed = sha256(normalised)
    const remaining = user.recoveryCodes ?? []
    if (!remaining.includes(hashed)) return null
    user.recoveryCodes = remaining.filter((h) => h !== hashed)
    await user.save()
    await auditService.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.recovery_code_used',
      metadata: { remaining: user.recoveryCodes.length },
    })
    return 'recovery_code' as const
  }

  private async countFailure(user: ConsoleUser, reason: string, meta: ClientMeta) {
    const settings = await settingsService.all()
    user.failedLogins += 1
    let locked = false
    if (user.failedLogins >= settings.login_max_failures) {
      user.lockedUntil = DateTime.now().plus({ minutes: settings.lockout_minutes })
      user.failedLogins = 0
      locked = true
    }
    await user.save()
    await auditService.record({
      actorId: user.id,
      actorEmail: user.email,
      action: locked ? 'auth.locked' : 'auth.login',
      outcome: 'denied',
      reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
  }

  private async userForSetupToken(token: string) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) {
      throw new ApiException(404, 'This link is not valid.', 'BAD_LINK')
    }
    const user = await ConsoleUser.query().where('setup_token_hash', sha256(token)).first()
    if (!user || user.status !== 'invited') throw new ApiException(404, 'This link is not valid.', 'BAD_LINK')
    if (!user.setupExpiresAt || user.setupExpiresAt <= DateTime.now()) {
      throw new ApiException(410, 'This link has expired. Ask an admin for a new one.', 'LINK_EXPIRED')
    }
    return user
  }
}

export default new AuthService()
