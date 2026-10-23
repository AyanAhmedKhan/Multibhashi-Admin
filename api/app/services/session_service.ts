import { DateTime } from 'luxon'
import ConsoleSession, { type SessionState } from '#models/console_session'
import consoleConfig from '#config/console'
import settingsService from '#services/settings_service'
import { randomToken, sha256 } from '#helpers/tokens'

export interface ClientMeta {
  ip: string
  userAgent: string | null
}

/** last_seen_at is written at most this often (every request would be a write). */
const TOUCH_EVERY_MS = 60_000

class SessionService {
  async create(userId: number, state: SessionState, meta: ClientMeta, mfaAt: DateTime | null = null) {
    const settings = await settingsService.all()
    const token = randomToken()
    const now = DateTime.now()
    const session = await ConsoleSession.create({
      userId,
      tokenHash: sha256(token),
      csrfToken: randomToken(24),
      state,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
      mfaAt,
      lastSeenAt: now,
      expiresAt:
        state === 'mfa_pending'
          ? now.plus({ minutes: consoleConfig.mfaPendingMinutes })
          : now.plus({ hours: settings.session_absolute_hours }),
    })
    return { token, session }
  }

  /**
   * The live session for a cookie token, or null. Expired and idle sessions are
   * revoked on the way (so the Sessions page shows why they ended).
   */
  async resolve(token: string | null | undefined) {
    if (!token || typeof token !== 'string' || token.length > 100) return null
    const session = await ConsoleSession.query()
      .where('token_hash', sha256(token))
      .whereNull('revoked_at')
      .first()
    if (!session) return null
    const now = DateTime.now()
    if (session.expiresAt <= now) {
      await this.revoke(session, 'expired')
      return null
    }
    if (session.state === 'active') {
      const { session_idle_minutes: idle } = await settingsService.all()
      if (session.lastSeenAt && session.lastSeenAt.plus({ minutes: idle }) <= now) {
        await this.revoke(session, 'idle')
        return null
      }
    }
    return session
  }

  async touch(session: ConsoleSession) {
    const last = session.lastSeenAt?.toMillis() ?? 0
    if (Date.now() - last < TOUCH_EVERY_MS) return
    session.lastSeenAt = DateTime.now()
    await session.save()
  }

  async revoke(session: ConsoleSession, reason: string) {
    if (session.revokedAt) return
    session.revokedAt = DateTime.now()
    session.revokedReason = reason
    await session.save()
  }

  /** Signs a user out everywhere (optionally keeping the session making the request). */
  async revokeAllForUser(userId: number, reason: string, exceptSessionId?: number) {
    const query = ConsoleSession.query().where('user_id', userId).whereNull('revoked_at')
    if (exceptSessionId) query.whereNot('id', exceptSessionId)
    return query.update({ revoked_at: new Date(), revoked_reason: reason })
  }

  /**
   * Password + MFA passed: the pending session is replaced by a fresh one with a new
   * token (no session fixation across the privilege change).
   */
  async activate(pending: ConsoleSession, meta: ClientMeta) {
    await this.revoke(pending, 'rotated')
    return this.create(pending.userId, 'active', meta, DateTime.now())
  }

  async listActive(userId: number) {
    return ConsoleSession.query()
      .where('user_id', userId)
      .where('state', 'active')
      .whereNull('revoked_at')
      .where('expires_at', '>', new Date())
      .orderBy('last_seen_at', 'desc')
  }
}

export default new SessionService()
