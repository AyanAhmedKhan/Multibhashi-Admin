import env from '#start/env'

/**
 * Fixed security constants. Tunable policy (session lengths, lockout, approval
 * thresholds, IP allowlist) lives in console_settings so a super admin can change it
 * on the Security page; `defaults` are used until then.
 */
export type MfaMethod = 'email' | 'totp' | 'off'

const consoleConfig = {
  origins: env
    .get('CONSOLE_ORIGINS')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean),

  cookie: {
    session: 'mbc_sid',
  },

  /** A login waiting for its MFA code expires this quickly. */
  mfaPendingMinutes: 5,
  /** Invite / access-reset links. */
  setupLinkHours: 48,
  /** Single-use recovery codes issued when MFA is set up. */
  recoveryCodes: 10,

  password: {
    min: 12,
    max: 128,
  },

  /** Approval requests nobody decided on expire. */
  approvalHours: 48,

  /** Defaults for console_settings (see SettingsService). */
  defaults: {
    /** Second sign-in step: a code by email (default), an authenticator app, or none. */
    mfa_method: 'email' as MfaMethod,
    session_idle_minutes: 30,
    session_absolute_hours: 12,
    step_up_minutes: 10,
    login_max_failures: 5,
    lockout_minutes: 15,
    grant_minutes_direct_limit: 60,
    grant_minutes_max: 600,
    // Complimentary AI Pro: above either limit a second person approves the grant.
    ai_pro_direct_max_days: 30,
    ai_pro_direct_max_minutes: 300,
    ip_allowlist: [] as string[],
  },
}

export type ConsoleSettings = typeof consoleConfig.defaults

export default consoleConfig
