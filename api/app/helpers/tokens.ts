import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** A URL-safe random token (256 bits by default). */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/** Tokens are stored only as their SHA-256, so a database leak can't be replayed. */
export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/** Constant-time string comparison (different lengths are simply unequal). */
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Recovery codes: 10 characters from an unambiguous alphabet, shown as xxxxx-xxxxx. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function recoveryCode() {
  const bytes = randomBytes(10)
  let code = ''
  for (const byte of bytes) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

/** What a typed recovery code is compared as: lower case, no spaces or dash. */
export function normaliseRecoveryCode(code: string) {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '')
}
