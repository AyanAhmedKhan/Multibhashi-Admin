import { mkdir, writeFile } from 'node:fs/promises'
import nodemailer, { type Transporter } from 'nodemailer'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import ApiException from '#exceptions/api_exception'

export interface Mail {
  to: string
  subject: string
  text: string
  html?: string
}

/**
 * Outgoing email over SMTP (Gmail works with an App Password). When SMTP isn't set up:
 * development writes each email to api/tmp/mail/*.json (so sign-in codes still work
 * locally); production refuses, and sign-in falls back to authenticator codes.
 */
class MailService {
  #transport: Transporter | null = null

  get configured() {
    return !!(env.get('SMTP_HOST') && env.get('SMTP_USER') && env.get('SMTP_PASSWORD'))
  }

  /** Whether codes can be delivered at all (real SMTP, or the dev outbox). */
  get canSend() {
    return this.configured || !app.inProduction
  }

  private transport() {
    this.#transport ??= nodemailer.createTransport({
      host: env.get('SMTP_HOST'),
      port: env.get('SMTP_PORT') ?? 465,
      secure: env.get('SMTP_SECURE') ?? (env.get('SMTP_PORT') ?? 465) === 465,
      auth: { user: env.get('SMTP_USER'), pass: env.get('SMTP_PASSWORD') },
      pool: true,
      maxConnections: 2,
    })
    return this.#transport
  }

  async send(mail: Mail) {
    if (this.configured) {
      await this.transport().sendMail({
        from: env.get('MAIL_FROM') ?? `MultiBhashi Console <${env.get('SMTP_USER')}>`,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      })
      return { delivered: 'smtp' as const }
    }
    if (app.inProduction) {
      throw new ApiException(503, 'Email isn’t set up on this server (SMTP).', 'MAIL_NOT_CONFIGURED')
    }
    const dir = app.makePath('tmp', 'mail')
    await mkdir(dir, { recursive: true })
    const file = `${Date.now()}-${mail.to.replace(/[^a-z0-9@.]/gi, '_')}.json`
    await writeFile(`${dir}/${file}`, JSON.stringify({ ...mail, at: new Date().toISOString() }, null, 2))
    logger.info({ to: mail.to, subject: mail.subject, file }, 'email written to the dev outbox (SMTP not configured)')
    return { delivered: 'outbox' as const }
  }

  /** For the health page: can we reach and log in to the SMTP server? */
  async verify() {
    if (!this.configured) return app.inProduction ? 'not configured' : 'not configured (dev outbox)'
    await this.transport().verify()
    return `${env.get('SMTP_USER')} via ${env.get('SMTP_HOST')}`
  }
}

export default new MailService()

/** A plain, readable HTML email around a short message (and an optional big code). */
export function simpleHtml(opts: { heading: string; lines: string[]; code?: string; link?: { href: string; label: string } }) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html><html><body style="margin:0;background:#f6f8fb;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="100%" style="max-width:480px;background:#ffffff;border:1px solid #e3e8ef;border-radius:12px" cellpadding="0" cellspacing="0">
<tr><td style="padding:24px 28px 8px"><div style="display:inline-block;background:#1976d2;color:#fff;font-weight:700;border-radius:8px;width:32px;height:32px;line-height:32px;text-align:center">M</div>
<span style="margin-left:8px;font-weight:600">MultiBhashi Console</span></td></tr>
<tr><td style="padding:8px 28px 24px"><h1 style="font-size:18px;margin:12px 0">${esc(opts.heading)}</h1>
${opts.lines.map((l) => `<p style="font-size:14px;line-height:1.5;color:#475569;margin:0 0 12px">${esc(l)}</p>`).join('')}
${opts.code ? `<div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#f1f5f9;border-radius:10px;padding:14px;text-align:center;margin:16px 0">${esc(opts.code)}</div>` : ''}
${opts.link ? `<p style="margin:20px 0"><a href="${esc(opts.link.href)}" style="background:#1976d2;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px">${esc(opts.link.label)}</a></p><p style="font-size:12px;color:#64748b;word-break:break-all">${esc(opts.link.href)}</p>` : ''}
<p style="font-size:12px;color:#94a3b8;margin-top:20px">If you didn’t expect this email, ignore it. Never share codes or links from this console with anyone.</p>
</td></tr></table></td></tr></table></body></html>`
}
