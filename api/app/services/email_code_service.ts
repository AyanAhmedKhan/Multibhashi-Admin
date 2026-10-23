import { createHmac, randomInt } from 'node:crypto'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import ApiException from '#exceptions/api_exception'
import mailService, { simpleHtml } from '#services/mail_service'
import { maskEmail } from '#helpers/mask'
import { safeEqual } from '#helpers/tokens'

export type CodePurpose = 'login' | 'step_up'

const VALID_MINUTES = 10
const MAX_ATTEMPTS = 5
const RESEND_SECONDS = 30
const MAX_PER_SESSION = 5

/** HMAC with APP_KEY: a leaked table can't be brute-forced offline (a code has only 10⁶ values). */
function digest(sessionId: number, purpose: CodePurpose, code: string) {
  return createHmac('sha256', env.get('APP_KEY')).update(`${sessionId}:${purpose}:${code}`).digest('hex')
}

/**
 * Six-digit sign-in codes by email, each bound to one session and purpose, valid ten
 * minutes, five tries, single use. Sending is throttled per session.
 */
class EmailCodeService {
  async send(user: { id: number; email: string; name: string }, sessionId: number, purpose: CodePurpose) {
    const recent = await db
      .from('console_email_codes')
      .where('session_id', sessionId)
      .where('purpose', purpose)
      .orderBy('id', 'desc')
      .select('created_at')
      .limit(MAX_PER_SESSION)
    if (recent.length >= MAX_PER_SESSION) {
      throw new ApiException(429, 'Too many codes for this sign-in. Start again.', 'CODE_LIMIT')
    }
    const last = recent[0]?.created_at ? new Date(recent[0].created_at).getTime() : 0
    const wait = Math.ceil((last + RESEND_SECONDS * 1000 - Date.now()) / 1000)
    if (wait > 0) throw new ApiException(429, `Wait ${wait} s before asking for another code.`, 'CODE_COOLDOWN')

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const now = new Date()
    await db.table('console_email_codes').insert({
      user_id: user.id,
      session_id: sessionId,
      purpose,
      code_hash: digest(sessionId, purpose, code),
      attempts: 0,
      expires_at: DateTime.now().plus({ minutes: VALID_MINUTES }).toJSDate(),
      created_at: now,
    })
    const first = user.name.split(/\s+/)[0]
    const what = purpose === 'login' ? 'sign in to' : 'confirm an action in'
    await mailService.send({
      to: user.email,
      subject: `${code} is your MultiBhashi Console code`,
      text: `Hi ${first},\n\nYour code to ${what} the MultiBhashi Admin Console is ${code}. It works once, for ${VALID_MINUTES} minutes.\n\nIf you didn't try to sign in, ignore this email and tell your admin.`,
      html: simpleHtml({
        heading: purpose === 'login' ? 'Your sign-in code' : 'Confirm it’s you',
        lines: [`Hi ${first}, use this code to ${what} the MultiBhashi Admin Console. It works once, for ${VALID_MINUTES} minutes.`],
        code,
      }),
    })
    return { sentTo: maskEmail(user.email), validMinutes: VALID_MINUTES }
  }

  /** True when the code matches the latest live code for this session (and consumes it). */
  async verify(sessionId: number, purpose: CodePurpose, code: string) {
    const clean = String(code ?? '').replace(/\s/g, '')
    if (!/^\d{6}$/.test(clean)) return false
    const row = await db
      .from('console_email_codes')
      .where('session_id', sessionId)
      .where('purpose', purpose)
      .whereNull('used_at')
      .where('expires_at', '>', new Date())
      .orderBy('id', 'desc')
      .first()
    if (!row || row.attempts >= MAX_ATTEMPTS) return false
    const ok = safeEqual(row.code_hash, digest(sessionId, purpose, clean))
    await db
      .from('console_email_codes')
      .where('id', row.id)
      .update(ok ? { used_at: new Date(), attempts: row.attempts + 1 } : { attempts: row.attempts + 1 })
    return ok
  }
}

export default new EmailCodeService()
