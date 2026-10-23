import { createHmac, randomBytes } from 'node:crypto'

/**
 * TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 s steps), the scheme every authenticator app
 * (Google Authenticator, Microsoft Authenticator, 1Password, Authy) supports.
 */

const STEP_SECONDS = 30
const DIGITS = 6
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buffer: Buffer) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(text: string) {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index === -1) throw new Error('invalid base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** A new 160-bit secret, base32 encoded (what the authenticator app stores). */
export function generateSecret() {
  return base32Encode(randomBytes(20))
}

export function timeStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_SECONDS)
}

export function hotp(secret: string, counter: number) {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest()
  const offset = digest[digest.length - 1] & 0xf
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3]
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

/**
 * The time step a code matches (current step ± `window` for clock drift), or null.
 * Callers reject a step that is not newer than the last accepted one (no replay).
 */
export function verifyTotp(secret: string, code: string, nowMs = Date.now(), window = 1) {
  const clean = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return null
  const current = timeStep(nowMs)
  for (let delta = -window; delta <= window; delta++) {
    if (hotp(secret, current + delta) === clean) return current + delta
  }
  return null
}

/** The otpauth:// URI an authenticator app scans as a QR code. */
export function otpauthUri(secret: string, account: string, issuer = 'MultiBhashi Console') {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
