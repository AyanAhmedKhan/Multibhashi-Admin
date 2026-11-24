import { FEATURES } from '#services/product_analytics/catalog'
import { dayRange } from '#services/product_analytics/insights_sql'
import type { Answer, NotReady, ProductInsights, Ready } from '#services/product_analytics/insights'

const isReady = <T>(a: Answer<T>): a is Ready<T> => a.connected && a.ready

/**
 * The Monday product digest (MUL-152, DESIGN §7): the last full IST week (Monday–Sunday) against
 * the week before: the KPIs, the biggest week-on-week changes and the top drop-off step. Built
 * from the same cached Insights queries as the pages, rendered as plain text and simple HTML.
 * Aggregates only: no learner appears in it.
 */

export interface DigestKpi {
  label: string
  value: string
  change: number | null
  note?: string
}

export interface DigestChange {
  label: string
  now: number
  before: number
  /** Relative change in %, for ranking. */
  change: number
  /** How to say it: a count, or a conversion in % (then now/before are percentages). */
  kind: 'count' | 'rate'
  unit: string
}

export interface DigestDropoff {
  funnel: string
  stoppedAfter: string
  nextStep: string
  lost: number
  stepConversion: number | null
  stepConversionBefore: number | null
}

export interface DigestData {
  week: { from: string; to: string }
  kpis: DigestKpi[]
  changes: DigestChange[]
  dropoff: DigestDropoff | null
  stale: string[]
  link: string | null
}

/** Ignore changes on numbers this small in both weeks: noise. */
export const MIN_VOLUME = 20
export const MAX_CHANGES = 5

const DAY_MS = 86_400_000
const dayNo = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS)
const label = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10)

/** The last Monday–Sunday week that has ended before `today` (IST days). */
export function lastFullWeek(today: string) {
  const t = dayNo(today)
  // 1970-01-01 was a Thursday: weekday 0 = Monday.
  const weekday = (t + 3) % 7
  const lastSunday = t - weekday - 1
  return { from: label(lastSunday - 6), to: label(lastSunday) }
}

const relative = (now: number, before: number) => (before ? ((now - before) / before) * 100 : null)
const round1 = (v: number) => Math.round(v * 10) / 10

export type DigestResult = { ok: true; data: DigestData } | { ok: false; reason: string }

/** Everything the e-mail says, from the Insights service, for the week ending `week.to`. */
export async function digestData(insights: ProductInsights, week: { from: string; to: string }, link: string | null): Promise<DigestResult> {
  const range = dayRange(7, week.to)
  const [overview, features, funnels, screens, status] = await Promise.all([
    insights.overview(range),
    insights.features(range),
    insights.funnels(range),
    insights.screens(range),
    insights.status(),
  ])
  if (!isReady(overview) || !isReady(features) || !isReady(funnels) || !isReady(screens) || !isReady(status)) {
    const blocked = [overview, features, funnels, screens, status].find((a) => !isReady(a))!
    if (!blocked.connected) return { ok: false, reason: `Product analytics is not connected (${blocked.problem ?? `missing ${blocked.missing.join(', ')}`})` }
    return { ok: false, reason: (blocked as NotReady).message }
  }
  const t = overview.totals
  const kpis: DigestKpi[] = [
    { label: 'Weekly active learners', value: fmt(t.periodActive), change: t.periodActiveChange },
    { label: 'New verified learners', value: fmt(t.newVerified), change: t.newVerifiedChange },
    {
      label: 'Activation (first value within 7 days)',
      value: t.activation.rate === null ? '—' : `${t.activation.rate}%`,
      change: null,
      note: `${fmt(t.activation.activated)} of ${fmt(t.activation.cohort)} who joined the week before`,
    },
    { label: 'Stickiness (avg DAU ÷ MAU)', value: `${t.stickiness}%`, change: null },
    { label: 'Sessions', value: fmt(t.sessions), change: t.sessionsChange, note: `${t.avgSessionMinutes} min on average` },
  ]

  const candidates: DigestChange[] = []
  const count = (name: string, now: number, before: number, unit: string) => {
    const c = relative(now, before)
    if (c !== null && Math.max(now, before) >= MIN_VOLUME && c !== 0) candidates.push({ label: name, now, before, change: round1(c), kind: 'count', unit })
  }
  count('Weekly active learners', t.periodActive, t.prevActive, 'learners')
  count('New verified learners', t.newVerified, t.prevVerified, 'learners')
  count('Sessions', t.sessions, t.prevSessions, 'sessions')
  for (const f of features.features) count(FEATURES.find((d) => d.key === f.key)?.label ?? f.key, f.users, f.prevUsers, 'learners')
  for (const s of screens.screens.slice(0, 15)) count(`${s.screen} screen`, s.views, s.prevViews, 'views')
  for (const f of funnels.funnels) {
    if (f.conversion === null || f.conversionBefore === null) continue
    const c = relative(f.conversion, f.conversionBefore)
    if (c !== null && c !== 0 && Math.min(f.steps[0].users, f.startedBefore) >= MIN_VOLUME) {
      candidates.push({ label: `${f.label} funnel conversion`, now: f.conversion, before: f.conversionBefore, change: round1(c), kind: 'rate', unit: '%' })
    }
  }
  const changes = candidates.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || b.now - a.now).slice(0, MAX_CHANGES)

  let dropoff: DigestDropoff | null = null
  for (const f of funnels.funnels) {
    for (let k = 1; k < f.steps.length; k++) {
      const lost = f.steps[k - 1].users - f.steps[k].users
      if (lost > 0 && (!dropoff || lost > dropoff.lost)) {
        const before = f.previous[k - 1] ? round1((f.previous[k] / f.previous[k - 1]) * 100) : null
        dropoff = { funnel: f.label, stoppedAfter: f.steps[k - 1].label, nextStep: f.steps[k].label, lost, stepConversion: f.steps[k].fromPrevious, stepConversionBefore: before }
      }
    }
  }
  const stale = status.sources.filter((s) => s.stale).map((s) => `${s.source} (${s.hours === null ? 'never' : `${s.hours} h ago`})`)
  return { ok: true, data: { week, kpis, changes, dropoff, stale, link } }
}

// ------------------------------------------------------------------ rendering

const fmt = (n: number) => n.toLocaleString('en-IN')
const signed = (v: number) => `${v > 0 ? '+' : ''}${v}%`

function longDay(day: string, withYear: boolean) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
}

export function weekLabel(week: { from: string; to: string }) {
  return `${longDay(week.from, false)} – ${longDay(week.to, true)}`
}

export function changeSentence(c: DigestChange) {
  const direction = c.change > 0 ? 'up' : 'down'
  if (c.kind === 'rate') return `${c.label}: ${c.now}% (was ${c.before}%), ${direction} ${Math.abs(c.change)}%`
  return `${c.label}: ${fmt(c.now)} ${c.unit} (was ${fmt(c.before)}), ${direction} ${Math.abs(c.change)}%`
}

export function dropoffSentence(d: DigestDropoff) {
  const conv =
    d.stepConversion === null ? '' : ` ${d.stepConversion}% made it to the next step${d.stepConversionBefore === null ? '' : ` (${d.stepConversionBefore}% the week before)`}.`
  return `${d.funnel}: ${fmt(d.lost)} learners stopped after "${d.stoppedAfter}" and never reached "${d.nextStep}".${conv}`
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function renderDigest(data: DigestData) {
  const subject = `MultiBhashi product digest: ${weekLabel(data.week)}`
  const kpiLine = (k: DigestKpi) => `${k.label}: ${k.value}${k.change === null ? '' : ` (${signed(k.change)} vs the week before)`}${k.note ? ` · ${k.note}` : ''}`
  const freshness = data.stale.length ? `Stale data: ${data.stale.join(', ')}. The numbers may be incomplete.` : 'All data sources were fresh.'
  const text = [
    `MultiBhashi product digest, week of ${weekLabel(data.week)} (IST)`,
    '',
    'KEY NUMBERS',
    ...data.kpis.map((k) => `- ${kpiLine(k)}`),
    '',
    'BIGGEST CHANGES, WEEK ON WEEK',
    ...(data.changes.length ? data.changes.map((c) => `- ${changeSentence(c)}`) : ['- Nothing moved by much (or volumes are still small).']),
    '',
    'TOP DROP-OFF',
    `- ${data.dropoff ? dropoffSentence(data.dropoff) : 'No funnel data this week.'}`,
    '',
    freshness,
    ...(data.link ? ['', `Open Insights: ${data.link}`] : []),
    '',
    'Aggregates only. Sent by the MultiBhashi admin console (analytics:weekly-digest).',
  ].join('\n')

  const row = (cells: string[], head = false) =>
    `<tr>${cells.map((c, i) => `<${head ? 'th' : 'td'} style="padding:6px 8px;border-bottom:1px solid #e3e8ef;text-align:${i ? 'right' : 'left'};font-size:13px;${head ? 'color:#64748b;font-weight:600' : ''}">${c}</${head ? 'th' : 'td'}>`).join('')}</tr>`
  const tone = (v: number | null) => (v === null ? '' : `<span style="color:${v >= 0 ? '#15803d' : '#b91c1c'}">${esc(signed(v))}</span>`)
  const html = `<!doctype html><html><body style="margin:0;background:#f6f8fb;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table width="100%" style="max-width:600px;background:#ffffff;border:1px solid #e3e8ef;border-radius:12px" cellpadding="0" cellspacing="0">
<tr><td style="padding:22px 26px 6px"><div style="font-size:12px;color:#64748b">MultiBhashi product digest</div>
<h1 style="font-size:19px;margin:6px 0 0">Week of ${esc(weekLabel(data.week))}</h1></td></tr>
<tr><td style="padding:12px 26px"><h2 style="font-size:14px;margin:8px 0">Key numbers</h2>
<table width="100%" cellpadding="0" cellspacing="0">${row(['', 'This week', 'vs last week'], true)}${data.kpis
    .map((k) => row([`${esc(k.label)}${k.note ? `<div style="font-size:12px;color:#64748b">${esc(k.note)}</div>` : ''}`, `<b>${esc(k.value)}</b>`, tone(k.change)]))
    .join('')}</table></td></tr>
<tr><td style="padding:6px 26px"><h2 style="font-size:14px;margin:8px 0">Biggest changes, week on week</h2>
<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6">${
    data.changes.length ? data.changes.map((c) => `<li>${esc(changeSentence(c))}</li>`).join('') : '<li>Nothing moved by much (or volumes are still small).</li>'
  }</ul></td></tr>
<tr><td style="padding:6px 26px"><h2 style="font-size:14px;margin:8px 0">Top drop-off</h2>
<p style="font-size:13px;line-height:1.6;margin:0">${esc(data.dropoff ? dropoffSentence(data.dropoff) : 'No funnel data this week.')}</p></td></tr>
<tr><td style="padding:12px 26px 22px"><p style="font-size:12px;color:${data.stale.length ? '#b45309' : '#64748b'};margin:0 0 10px">${esc(freshness)}</p>
${data.link ? `<a href="${esc(data.link)}" style="background:#1976d2;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600;font-size:13px">Open Insights</a>` : ''}
<p style="font-size:11px;color:#94a3b8;margin-top:16px">Aggregates only. Sent by the MultiBhashi admin console (analytics:weekly-digest).</p>
</td></tr></table></td></tr></table></body></html>`
  return { subject, text, html }
}

/** Example numbers for previewing the e-mail (--sample): not real data. */
export const SAMPLE_DIGEST: DigestData = {
  week: { from: '2026-11-16', to: '2026-11-22' },
  kpis: [
    { label: 'Weekly active learners', value: '1,240', change: 6.4 },
    { label: 'New verified learners', value: '310', change: -12.5 },
    { label: 'Activation (first value within 7 days)', value: '41.2%', change: null, note: '120 of 291 who joined the week before' },
    { label: 'Stickiness (avg DAU ÷ MAU)', value: '18.3%', change: null },
    { label: 'Sessions', value: '6,820', change: 3.1, note: '7.4 min on average' },
  ],
  changes: [
    { label: 'AI tutor class', now: 420, before: 300, change: 40, kind: 'count', unit: 'learners' },
    { label: 'Purchase funnel conversion', now: 2.1, before: 3, change: -30, kind: 'rate', unit: '%' },
    { label: 'Plans screen', now: 900, before: 760, change: 18.4, kind: 'count', unit: 'views' },
  ],
  dropoff: { funnel: 'Sign-up → first value', stoppedAfter: 'OTP requested', nextStep: 'OTP verified', lost: 214, stepConversion: 63.5, stepConversionBefore: 68.9 },
  stale: [],
  link: null,
}

/** ANALYTICS_DIGEST_TO: comma-separated addresses; anything that isn't one is reported, not sent to. */
export function recipients(value: string | undefined) {
  const list = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const valid = list.filter((s) => /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(s))
  return { valid, invalid: list.filter((s) => !valid.includes(s)) }
}
