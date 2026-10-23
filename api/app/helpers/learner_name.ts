/**
 * App sign-ups by phone get the placeholder name "User" (and the app then locks the
 * name field, so the learner can't replace it). Treat that like no name at all.
 */
const PLACEHOLDERS = new Set(['', 'user', 'null', 'undefined', 'na', 'n/a'])

export function realName(name: unknown): string | null {
  const text = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
  return PLACEHOLDERS.has(text.toLowerCase()) ? null : text
}

/** Letters (any script), spaces, dots, apostrophes and hyphens: what a person's name needs. */
export const LEARNER_NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u
