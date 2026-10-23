import consoleConfig from '#config/console'

/**
 * NIST SP 800-63B style: long passphrases, no forced composition rules or periodic
 * rotation, but refuse the obvious (common passwords, the account's own email or name).
 * MFA is the real protection; this keeps the first factor from being trivial.
 */
const COMMON = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwerty',
  'qwertyuiop',
  '123456789',
  '1234567890',
  '12345678910',
  '123456789012',
  'iloveyou',
  'admin',
  'admin123',
  'administrator',
  'welcome',
  'welcome123',
  'letmein',
  'default',
  'changeme',
  'multibhashi',
  'multibhashi123',
  'multibhashi@123',
  'india123',
  'abcd1234',
])

export function passwordProblem(password: string, account: { email: string; name?: string }) {
  const { min, max } = consoleConfig.password
  if (password.length < min) return `Use at least ${min} characters (a short sentence works well).`
  if (password.length > max) return `Use at most ${max} characters.`
  const lower = password.toLowerCase()
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9@]/g, ''))) {
    return 'That password is too common.'
  }
  if (new Set(lower).size < 5) return 'Use more varied characters.'
  const localPart = account.email.split('@')[0]?.toLowerCase()
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
    return 'Don’t include your email address.'
  }
  const firstName = account.name?.trim().split(/\s+/)[0]?.toLowerCase()
  if (firstName && firstName.length >= 4 && lower.includes(firstName)) {
    return 'Don’t include your name.'
  }
  return null
}
