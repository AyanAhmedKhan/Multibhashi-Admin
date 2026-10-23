/**
 * Contact details are masked unless the viewer holds `learners.pii.read` and asked to
 * reveal them (each reveal is audited). Masks keep enough to confirm an identity on a
 * support call ("the number ending 210?") without exposing it.
 */

export function maskPhone(phone: string | null | undefined) {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 6) return '•'.repeat(digits.length)
  return `${digits.slice(0, 2)}${'•'.repeat(digits.length - 5)}${digits.slice(-3)}`
}

export function maskEmail(email: string | null | undefined) {
  if (!email) return null
  const at = email.indexOf('@')
  if (at < 1) return '•••'
  const domain = email.slice(at + 1)
  return `${email[0]}•••@${domain}`
}

/** Masks a free-text name to its first letter of each word ("Ayan Pal" → "A••• P•••"). */
export function maskName(name: string | null | undefined) {
  if (!name) return null
  return name
    .trim()
    .split(/\s+/)
    .map((word) => `${word[0]}•••`)
    .join(' ')
}
