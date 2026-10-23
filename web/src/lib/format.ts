const IST = 'Asia/Kolkata'

const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const dateOnly = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short' })

/** Every time in the console is shown in IST, labelled once in the page header. */
export function fmtDateTime(value: string | Date | null | undefined) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : dateTime.format(d)
}

export function fmtDay(value: string) {
  return dateOnly.format(new Date(`${value}T00:00:00+05:30`))
}

export function fmtAgo(value: string | Date | null | undefined) {
  if (!value) return '—'
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return fmtDateTime(value)
}

export const fmtInt = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-IN')

export function fmtMinutes(n: number | null | undefined) {
  const v = n ?? 0
  if (v < 60) return `${v} min`
  const h = Math.floor(v / 60)
  const m = v % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** "tutor.minutes.granted" → "Tutor minutes granted" */
export function humanAction(action: string) {
  const text = action.replace(/[._]/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const inr = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? '—' : `₹${v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

/** Quantities in the unit people think in: audio hours, minutes, K/M characters and tokens. */
export function fmtQuantity(quantity: number, unit: string) {
  if (unit === 'audio_seconds' || unit === 'output_audio_seconds') {
    if (quantity < 120) return `${Math.round(quantity)} audio s`
    if (quantity < 3600) return `${(quantity / 60).toLocaleString('en-IN', { maximumFractionDigits: 1 })} audio min`
    return `${(quantity / 3600).toLocaleString('en-IN', { maximumFractionDigits: 1 })} audio h`
  }
  if (unit === 'participant_seconds') return `${fmtInt(Math.round(quantity / 60))} participant-min`
  const label = unit === 'characters' ? 'chars' : 'tokens'
  if (quantity >= 1_000_000) return `${(quantity / 1_000_000).toLocaleString('en-IN', { maximumFractionDigits: 2 })}M ${label}`
  if (quantity >= 1000) return `${(quantity / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 })}K ${label}`
  return `${fmtInt(Math.round(quantity))} ${label}`
}
