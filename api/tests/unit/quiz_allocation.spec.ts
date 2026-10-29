import { test } from '@japa/runner'
import {
  MARKING,
  allocate,
  billedSpeechSeconds,
  estimate,
  interpolate,
  markingTokens,
  type AnswerFacts,
  type Rates,
} from '#services/analytics/quiz_allocation'
import { attemptsFrom, markingPath, sentencesFrom } from '#services/analytics/quiz_analytics'
import { priceModelOf, providerActuals, ratesFor } from '#services/analytics/quiz_cost'
import { DEFAULT_COST_MODEL } from '#services/analytics/cost_model'

// gpt-4o-mini list prices and V2 speech at ₹95.2/$ (the rate card's figures)
const RATES: Rates = {
  speechPerSecondInr: (0.016 / 60) * 95.2,
  inputPerTokenInr: (0.15 / 1_000_000) * 95.2,
  outputPerTokenInr: (0.6 / 1_000_000) * 95.2,
}
const answer = (over: Partial<AnswerFacts>): AnswerFacts => ({
  key: over.key ?? 'a',
  type: 'SQ',
  day: '2026-10-28',
  path: 'legacy',
  words: 40,
  sentences: 3,
  attempts: 1,
  recordedSeconds: null,
  ...over,
})

test.group('Quiz cost weights', () => {
  test('speech: recorded seconds when the app sent them, else words ÷ 2.3; 1–58 s, rounded up', ({ assert }) => {
    assert.deepEqual(billedSpeechSeconds({ type: 'SQ', words: 40, recordedSeconds: 12.4 }), { seconds: 13, from: 'recording' })
    assert.deepEqual(billedSpeechSeconds({ type: 'SQ', words: 23, recordedSeconds: null }), { seconds: 10, from: 'words' })
    assert.equal(billedSpeechSeconds({ type: 'SQ', words: 0, recordedSeconds: null }).seconds, 1, 'an empty transcript is still billed')
    assert.equal(billedSpeechSeconds({ type: 'SQ', words: 500, recordedSeconds: null }).seconds, 58)
    assert.equal(billedSpeechSeconds({ type: 'SQ', words: 5, recordedSeconds: 90 }).seconds, 58)
    assert.equal(billedSpeechSeconds({ type: 'WQ', words: 120, recordedSeconds: null }).seconds, 0)
  })

  test('marking tokens per path (spec §4)', ({ assert }) => {
    assert.deepEqual(markingTokens({ path: 'legacy', words: 40, sentences: 3, attempts: 1 }), { calls: 1, input: 600, output: 150 })
    const counted = markingTokens({ path: 'counted', words: 40, sentences: 3, attempts: 1 })
    assert.equal(counted.input + counted.output, 1650)
    // evidence: 2 grammar calls + 1 content call
    const e40 = markingTokens({ path: 'evidence', words: 40, sentences: 3, attempts: 1 })
    assert.equal(e40.calls, 3)
    assert.equal(e40.input, 2 * 3100 + 1300)
    assert.equal(e40.output, 2 * 210 * 3 + MARKING.evidence.contentOutput.base + MARKING.evidence.contentOutput.perSentence * 3)
    assert.equal(markingTokens({ path: 'evidence', words: 100, sentences: 6, attempts: 1 }).input, Math.round(2 * 5760 + interpolate(MARKING.evidence.contentInput, 100)))
    assert.equal(markingTokens({ path: 'evidence', words: 180, sentences: 10, attempts: 1 }).input, 2 * 8840 + 2800)
    // A retry repeats all three calls
    const retried = markingTokens({ path: 'evidence', words: 40, sentences: 3, attempts: 2 })
    assert.equal(retried.calls, 6)
    assert.equal(retried.input, 2 * e40.input)
    assert.deepEqual(markingTokens({ path: 'evidence', words: 0, sentences: 0, attempts: 1 }), { calls: 0, input: 0, output: 0 }, 'empty answers are not marked')
  })

  test('the measured grammar input curve is followed between and beyond the points', ({ assert }) => {
    const pts = MARKING.evidence.grammarInput
    assert.equal(interpolate(pts, 40), 3100)
    assert.equal(interpolate(pts, 70), 3100 + (5760 - 3100) / 2)
    assert.equal(interpolate(pts, 140), 5760 + (8840 - 5760) / 2)
    assert.isAbove(interpolate(pts, 250), 8840)
  })

  test('marking path, attempts and sentences from the stored columns', ({ assert }) => {
    assert.equal(markingPath(null, null), 'legacy')
    assert.equal(markingPath(1, 'english-v1.4'), 'legacy')
    assert.equal(markingPath(2, 'english-v1.4'), 'counted')
    assert.equal(markingPath(3, 'english-evidence-v4'), 'evidence')
    assert.equal(markingPath(null, 'english-evidence-v5'), 'evidence')
    assert.equal(attemptsFrom([]), 1)
    assert.equal(attemptsFrom(['assessment_1', 'review_1', 'assessment_2', 'content_2']), 2)
    assert.equal(attemptsFrom(['rubric']), 1)
    assert.equal(sentencesFrom(0, 0), 0)
    assert.equal(sentencesFrom(30, 0), 2, 'unpunctuated transcript: ~15 words a sentence')
    assert.equal(sentencesFrom(12, 3), 3)
  })
})

test.group('Quiz cost allocation', () => {
  test('a day with an actual speech bill is spread by billed seconds and adds up exactly', ({ assert }) => {
    const answers = [
      answer({ key: 'short', recordedSeconds: 10 }),
      answer({ key: 'long', recordedSeconds: 30 }),
      answer({ key: 'w', type: 'WQ', words: 120 }),
    ]
    const { answers: out, days } = allocate(answers, new Map([['2026-10-28', { speechInr: 10 }]]), () => RATES)
    const by = (k: string) => out.find((a) => a.key === k)!
    assert.closeTo(by('short').speechInr, 2.5, 1e-9)
    assert.closeTo(by('long').speechInr, 7.5, 1e-9)
    assert.equal(by('short').speechBasis, 'actual')
    assert.equal(by('w').speechInr, 0)
    assert.isNull(by('w').speechBasis)
    const day = days.get('2026-10-28')!
    assert.equal(day.speech.basis, 'actual')
    assert.closeTo(day.speech.inr, 10, 1e-9)
    assert.closeTo(day.speech.unallocatedInr, 0, 1e-9)
    // marking had no provider data that day: estimated, and labelled so
    assert.equal(day.marking.basis, 'estimated')
    assert.equal(by('w').markingBasis, 'estimated')
    assert.closeTo(by('w').markingInr, estimate(answers[2], RATES).markingInr, 1e-12)
  })

  test('marking is spread by estimated cost: an evidence answer carries more than a legacy one', ({ assert }) => {
    const answers = [
      answer({ key: 'legacy', type: 'WQ', path: 'legacy', words: 60 }),
      answer({ key: 'evidence', type: 'WQ', path: 'evidence', words: 60, sentences: 4 }),
      answer({ key: 'empty', type: 'WQ', path: 'evidence', words: 0, sentences: 0 }),
    ]
    const { answers: out, days } = allocate(answers, new Map([['2026-10-28', { markingInr: 5, markingBasis: 'actual' as const }]]), () => RATES)
    const by = (k: string) => out.find((a) => a.key === k)!
    const wL = estimate(answers[0], RATES).markingInr
    const wE = estimate(answers[1], RATES).markingInr
    assert.closeTo(by('legacy').markingInr, (5 * wL) / (wL + wE), 1e-9)
    assert.closeTo(by('legacy').markingInr + by('evidence').markingInr, 5, 1e-9)
    assert.isAbove(by('evidence').markingInr, by('legacy').markingInr * 5)
    assert.equal(by('empty').markingInr, 0)
    assert.isNull(by('empty').markingBasis)
    assert.equal(days.get('2026-10-28')!.marking.basis, 'actual')
  })

  test('usage-priced marking keeps its own label', ({ assert }) => {
    const { answers: out } = allocate([answer({ type: 'WQ' })], new Map([['2026-10-28', { markingInr: 1, markingBasis: 'usage' as const }]]), () => RATES)
    assert.equal(out[0].markingBasis, 'usage')
  })

  test('a day without provider data is the estimate, never "actual"; a bill with no answers stays unallocated', ({ assert }) => {
    const answers = [answer({ key: 'x', day: '2026-10-27', recordedSeconds: 30 })]
    const actuals = new Map([['2026-10-26', { speechInr: 3, markingInr: 2, markingBasis: 'actual' as const }]])
    const { answers: out, days } = allocate(answers, actuals, () => RATES)
    assert.equal(out[0].speechBasis, 'estimated')
    assert.equal(out[0].markingBasis, 'estimated')
    assert.closeTo(out[0].speechInr, 30 * RATES.speechPerSecondInr, 1e-12)
    assert.equal(days.get('2026-10-27')!.speech.basis, 'estimated')
    const empty = days.get('2026-10-26')!
    assert.equal(empty.speech.basis, 'actual')
    assert.equal(empty.speech.unallocatedInr, 3)
    assert.equal(empty.marking.unallocatedInr, 2)
    assert.equal(empty.speech.answers, 0)
  })

  test('the estimate is weights × rate card: a 40-word legacy SQ answer', ({ assert }) => {
    const e = estimate(answer({ words: 40, recordedSeconds: null }), RATES)
    assert.equal(e.speechSeconds, 18) // 40 / 2.3 = 17.4 → 18 s
    assert.closeTo(e.speechInr, 18 * (0.016 / 60) * 95.2, 1e-12)
    assert.closeTo(e.markingInr, (600 * 0.15 + 150 * 0.6) / 1_000_000 * 95.2, 1e-12)
  })
})

test.group('Quiz cost: which days the providers reported', () => {
  const model = structuredClone(DEFAULT_COST_MODEL)
  const row = (day: string, provider: string, source: string, item: string, unit: string, quantity: number, costUsd: number, scope = 'multibhashi-android-app') => ({
    day,
    provider,
    scope,
    item,
    unit,
    quantity,
    costUsd,
    source,
  })
  const rows = [
    row('2026-10-27', 'google', 'gcp_billing_export', 'Speech / Recognition', 'seconds', 600, 0.16),
    row('2026-10-27', 'google', 'gcp_billing_export', 'Storage / Standard Storage Mumbai', 'byte-seconds', 1e12, 5),
    row('2026-10-27', 'google', 'gcp_billing_export', 'Speech / Recognition', 'seconds', 60, 1, 'some-other-project'),
    row('2026-10-27', 'openai', 'openai_costs_api', 'gpt-4o-mini-2024-07-18, input', 'tokens', 100_000, 0.015, 'proj_q'),
    row('2026-10-28', 'openai', 'openai_usage_api', 'gpt-4o-mini-2024-07-18', 'input_tokens', 1_000_000, 0, 'proj_q/key'),
    row('2026-10-28', 'openai', 'openai_usage_api', 'gpt-4o-mini-2024-07-18', 'requests', 500, 0, 'proj_q/key'),
    row('2026-10-28', 'openai', 'openai_usage_api', 'o9-preview', 'output_tokens', 10, 0, 'proj_q/key'),
  ]
  const coverage = {
    google: { from: '2026-10-27', through: '2026-10-28T23:00:00.000Z' },
    openai: { from: '2026-10-27', through: '2026-10-29T04:30:00.000Z' },
  }

  test('reported days are actual (zero if nothing billed); days before the first sync or not yet complete are left to the estimate', ({ assert }) => {
    const reported = providerActuals(rows, model, coverage, 'multibhashi-android-app')
    const a = reported.actualsFor(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'])
    assert.isFalse(a.has('2026-10-26'), 'before the first synced day')
    assert.closeTo(a.get('2026-10-27')!.speechInr!, 0.16 * model.usdToInr, 1e-9, 'speech SKUs of the speech project only')
    assert.equal(a.get('2026-10-28')!.speechInr, 0, 'export complete past the day, no speech billed')
    assert.isUndefined(a.get('2026-10-29')?.speechInr, 'export not through the 29th yet')
    assert.equal(a.get('2026-10-27')!.markingBasis, 'actual')
    assert.closeTo(a.get('2026-10-27')!.markingInr!, 0.015 * model.usdToInr, 1e-9)
    // No Costs API row on the 28th: OpenAI's own token counts × list price (snapshot → model line)
    assert.equal(a.get('2026-10-28')!.markingBasis, 'usage')
    assert.closeTo(a.get('2026-10-28')!.markingInr!, 0.15 * model.usdToInr, 1e-9)
    assert.isUndefined(a.get('2026-10-29')?.markingInr, 'OpenAI’s bucket for the 29th is still open')
    assert.deepEqual(reported.unpriced, ['o9-preview output_tokens'])
  })

  test('not connected: no day is actual', ({ assert }) => {
    const none = providerActuals([], model, { google: { from: null, through: null }, openai: { from: null, through: null } }, null)
    assert.equal(none.actualsFor(['2026-10-28']).size, 0)
  })

  test('snapshot names price on the model line; rates come from the rate card', ({ assert }) => {
    assert.equal(priceModelOf('gpt-4o-mini-2024-07-18'), 'gpt-4o-mini')
    assert.equal(priceModelOf('gpt-4o-mini'), 'gpt-4o-mini')
    const r = ratesFor(model, '2026-10-29')
    assert.closeTo(r.speechPerSecondInr, (0.016 / 60) * model.usdToInr, 1e-12)
    assert.closeTo(r.inputPerTokenInr, (0.15 / 1e6) * model.usdToInr, 1e-15)
    assert.closeTo(r.outputPerTokenInr, (0.6 / 1e6) * model.usdToInr, 1e-15)
  })
})
