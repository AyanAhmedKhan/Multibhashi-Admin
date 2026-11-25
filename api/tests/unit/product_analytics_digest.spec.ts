import { test } from '@japa/runner'
import { MIN_VOLUME, SAMPLE_DIGEST, changeSentence, digestData, lastFullWeek, recipients, renderDigest } from '#services/product_analytics/digest'
import type { ProductInsights } from '#services/product_analytics/insights'
import { FUNNELS } from '#services/product_analytics/catalog'
import { dayRange } from '#services/product_analytics/insights_sql'

const WEEK = { from: '2026-11-16', to: '2026-11-22' }
const ready = <T extends object>(data: T) => ({ connected: true as const, ready: true as const, range: dayRange(7, WEEK.to), ...data })

/** An Insights stand-in returning fixed page answers. */
function fakeInsights(over: { funnelSteps?: Record<string, { now: number[]; before: number[] }>; stale?: boolean; notConnected?: boolean } = {}) {
  const steps = over.funnelSteps ?? {}
  return {
    overview: async () =>
      over.notConnected
        ? { connected: false, missing: ['GCP_ANALYTICS_PROJECT'], problem: null, location: 'asia-south1' }
        : ready({
            totals: {
              dau: 100, wau: 900, mau: 3000, stickiness: 12.5,
              periodActive: 900, prevActive: 1000, periodActiveChange: -10,
              sessions: 5000, prevSessions: 4000, sessionsChange: 25, avgSessionMinutes: 6.5,
              newVerified: 60, prevVerified: 40, newVerifiedChange: 50,
              activation: { cohort: 50, activated: 20, rate: 40, bySignup: 50 },
            },
            series: [], weekly: [], platforms: [],
          }),
    features: async () =>
      ready({
        wau: 900,
        features: [
          { key: 'ai_tutor', label: 'AI tutor class', users: 300, prevUsers: 150, usersChange: 100, users7d: 300, adoption: 33, uses: 900, usesPerUser: 3, series: [] },
          // Tiny numbers: a 400% change on 2 → 10 is noise and must not lead the digest.
          { key: 'chat', label: 'Chat', users: 10, prevUsers: 2, usersChange: 400, users7d: 10, adoption: 1, uses: 12, usesPerUser: 1.2, series: [] },
        ],
        retention: [],
      }),
    screens: async () => ready({ screens: [{ screen: 'Home', views: 4000, prevViews: 3900, viewsChange: 2.6, users: 800, medianSeconds: 30, exits: 100, exitRate: 2.5, into: [], outOf: [] }] }),
    funnels: async () =>
      ready({
        breakdown: null,
        segments: [],
        funnels: FUNNELS.map((f) => {
          const s = steps[f.key] ?? { now: f.steps.map(() => 0), before: f.steps.map(() => 0) }
          return {
            key: f.key,
            label: f.label,
            windowDays: f.windowDays,
            steps: f.steps.map((d, k) => ({
              label: d.label,
              users: s.now[k],
              medianGapSeconds: null,
              fromPrevious: k ? (s.now[k - 1] ? Math.round((s.now[k] / s.now[k - 1]) * 1000) / 10 : null) : null,
              fromFirst: null,
              dropped: k ? s.now[k - 1] - s.now[k] : 0,
            })),
            conversion: s.now[0] ? Math.round((s.now[s.now.length - 1] / s.now[0]) * 1000) / 10 : null,
            conversionBefore: s.before[0] ? Math.round((s.before[s.before.length - 1] / s.before[0]) * 1000) / 10 : null,
            startedBefore: s.before[0],
            previous: s.before,
          }
        }),
      }),
    status: async () => ready({ sources: [{ source: 'm_sessions', at: null, hours: over.stale ? 40 : 2, stale: !!over.stale }] }),
  } as unknown as ProductInsights
}

test.group('Weekly digest (MUL-152)', () => {
  test('reports the last full Monday–Sunday week before today (IST)', ({ assert }) => {
    assert.deepEqual(lastFullWeek('2026-11-23'), WEEK) // a Monday
    assert.deepEqual(lastFullWeek('2026-11-24'), WEEK) // Tuesday
    assert.deepEqual(lastFullWeek('2026-11-22'), { from: '2026-11-09', to: '2026-11-15' }) // Sunday: that week isn't over
  })

  test('KPIs, the biggest changes (small numbers ignored) and the top drop-off', async ({ assert }) => {
    const result = await digestData(
      fakeInsights({
        funnelSteps: {
          signup: { now: [1000, 800, 700, 300, 250, 100], before: [900, 700, 600, 330, 260, 120] },
          quiz: { now: [200, 180, 150, 120], before: [100, 90, 80, 70] },
        },
      }),
      WEEK,
      'https://console.example.invalid/insights/overview?days=7'
    )
    assert.isTrue(result.ok)
    if (!result.ok) return
    const d = result.data
    assert.deepEqual(d.kpis.map((k) => [k.label, k.value, k.change]), [
      ['Weekly active learners', '900', -10],
      ['New verified learners', '60', 50],
      ['Activation (first value within 7 days)', '40%', null],
      ['Stickiness (avg DAU ÷ MAU)', '12.5%', null],
      ['Sessions', '5,000', 25],
    ])
    assert.equal(d.changes[0].label, 'AI tutor class')
    assert.equal(d.changes[0].change, 100)
    assert.notInclude(d.changes.map((c) => c.label), 'Chat', `under ${MIN_VOLUME} both weeks`)
    assert.isAtMost(d.changes.length, 5)
    // Largest absolute loss: signup OTP requested (700) → OTP verified (300).
    assert.deepEqual(d.dropoff, {
      funnel: 'Sign-up → first value',
      stoppedAfter: 'OTP requested',
      nextStep: 'OTP verified',
      lost: 400,
      stepConversion: 42.9,
      stepConversionBefore: 55,
    })
    assert.deepEqual(d.stale, [])
  })

  test('nothing is built when product analytics is not connected', async ({ assert }) => {
    const result = await digestData(fakeInsights({ notConnected: true }), WEEK, null)
    assert.isFalse(result.ok)
    if (!result.ok) assert.match(result.reason, /not connected \(missing GCP_ANALYTICS_PROJECT\)/)
  })

  test('the e-mail: subject, sections, freshness warning and escaped HTML', ({ assert }) => {
    const data = { ...SAMPLE_DIGEST, stale: ['m_sessions (40 h ago)'], changes: [{ ...SAMPLE_DIGEST.changes[0], label: '<script>x</script> screen' }] }
    const mail = renderDigest(data)
    assert.equal(mail.subject, 'MultiBhashi product digest: 16 Nov – 22 Nov 2026')
    for (const part of ['KEY NUMBERS', 'BIGGEST CHANGES, WEEK ON WEEK', 'TOP DROP-OFF', 'Weekly active learners: 1,240 (+6.4% vs the week before)', 'Stale data: m_sessions (40 h ago)']) {
      assert.include(mail.text, part)
    }
    assert.include(mail.text, '214 learners stopped after "OTP requested" and never reached "OTP verified". 63.5% made it to the next step (68.9% the week before).')
    assert.notInclude(mail.html, '<script>')
    assert.include(mail.html, '&lt;script&gt;x&lt;/script&gt; screen')
    assert.notInclude(mail.text, '@', 'no e-mail address in the body')
  })

  test('change sentences for counts and conversion rates', ({ assert }) => {
    assert.equal(changeSentence({ label: 'Sessions', now: 1200, before: 1000, change: 20, kind: 'count', unit: 'sessions' }), 'Sessions: 1,200 sessions (was 1,000), up 20%')
    assert.equal(changeSentence({ label: 'Quiz funnel conversion', now: 9.5, before: 12, change: -20.8, kind: 'rate', unit: '%' }), 'Quiz funnel conversion: 9.5% (was 12%), down 20.8%')
  })

  test('recipients: comma-separated addresses; anything else is reported, not sent to', ({ assert }) => {
    assert.deepEqual(recipients(' team@example.invalid, ops@example.invalid ,not-an-address,'), {
      valid: ['team@example.invalid', 'ops@example.invalid'],
      invalid: ['not-an-address'],
    })
    assert.deepEqual(recipients(undefined), { valid: [], invalid: [] })
  })
})
