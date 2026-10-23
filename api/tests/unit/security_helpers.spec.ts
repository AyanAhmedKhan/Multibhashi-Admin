import { test } from '@japa/runner'
import { base32Decode, base32Encode, hotp, otpauthUri, verifyTotp } from '#helpers/totp'
import { maskEmail, maskName, maskPhone } from '#helpers/mask'
import { passwordProblem } from '#helpers/password_policy'
import { normaliseRecoveryCode, recoveryCode, safeEqual } from '#helpers/tokens'

// RFC 6238 appendix B test secret (ASCII "12345678901234567890"), SHA-1, 8 digits there;
// the 6-digit codes below are the same values mod 10^6.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

test.group('TOTP', () => {
  test('base32 round-trips', ({ assert }) => {
    const bytes = Buffer.from('any bytes \u0000ÿ here')
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes)
  })

  test('matches the RFC 6238 vectors', ({ assert }) => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ]
    for (const [seconds, code] of vectors) {
      assert.equal(hotp(RFC_SECRET, Math.floor(seconds / 30)), code)
    }
  })

  test('accepts one step of drift, rejects two and junk', ({ assert }) => {
    const now = 1111111111 * 1000
    const step = Math.floor(now / 30000)
    assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now), step - 1)
    assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now), step + 1)
    assert.isNull(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now))
    assert.isNull(verifyTotp(RFC_SECRET, '12345', now))
    assert.isNull(verifyTotp(RFC_SECRET, 'abcdef', now))
  })

  test('builds an otpauth URI apps understand', ({ assert }) => {
    const uri = otpauthUri('ABC', 'ops@multibhashi.com')
    assert.isTrue(uri.startsWith('otpauth://totp/MultiBhashi%20Console%3Aops%40multibhashi.com?'))
    assert.include(uri, 'secret=ABC')
    assert.include(uri, 'period=30')
  })
})

test.group('Masking', () => {
  test('phone keeps first two and last three digits', ({ assert }) => {
    assert.equal(maskPhone('9876543210'), '98•••••210')
    assert.equal(maskPhone('+91 98765 43210'), '91•••••••210')
    assert.isNull(maskPhone(null))
  })

  test('email keeps first letter and domain', ({ assert }) => {
    assert.equal(maskEmail('ayan@example.com'), 'a•••@example.com')
    assert.equal(maskEmail('bad'), '•••')
  })

  test('name keeps initials', ({ assert }) => {
    assert.equal(maskName('Test Learner'), 'T••• L•••')
  })
})

test.group('Password policy', () => {
  const account = { email: 'priya.sharma@multibhashi.com', name: 'Priya Sharma' }

  test('refuses short, common, and personal passwords', ({ assert }) => {
    assert.isString(passwordProblem('short', account))
    assert.isString(passwordProblem('multibhashi@123', account))
    assert.isString(passwordProblem('aaaaaaaaaaaaaaa', account))
    assert.isString(passwordProblem('priya.sharma-2026!', account))
    assert.isString(passwordProblem('Priya loves chai daily', account))
  })

  test('accepts a passphrase', ({ assert }) => {
    assert.isNull(passwordProblem('monsoon tea on the balcony', account))
  })
})

test.group('Tokens', () => {
  test('recovery codes are 10 unambiguous characters and normalise', ({ assert }) => {
    const code = recoveryCode()
    assert.match(code, /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/)
    assert.equal(normaliseRecoveryCode(` ${code.toUpperCase()} `), code.replace('-', ''))
  })

  test('safeEqual compares exactly', ({ assert }) => {
    assert.isTrue(safeEqual('abc', 'abc'))
    assert.isFalse(safeEqual('abc', 'abd'))
    assert.isFalse(safeEqual('abc', 'abcd'))
  })
})
