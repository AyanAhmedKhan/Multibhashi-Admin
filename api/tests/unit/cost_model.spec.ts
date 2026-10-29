import { test } from '@japa/runner'
import {
  DEFAULT_COST_MODEL,
  ENGINES,
  estimateEngine,
  perMinuteInr,
  lineFor,
  modelStatus,
  priceFor,
  unitPriceInr,
  validateCostModel,
  withLatestPrices,
  withNewDefaults,
} from '#services/analytics/cost_model'

const clone = () => structuredClone(DEFAULT_COST_MODEL)

test.group('Cost model', () => {
  test('the defaults are a valid model and every estimate points at a price', ({ assert }) => {
    assert.doesNotThrow(() => validateCostModel(clone()))
    for (const engine of ENGINES) {
      for (const u of DEFAULT_COST_MODEL.assumptions[engine].usage) {
        assert.exists(DEFAULT_COST_MODEL.prices.find((p) => p.id === u.priceId), `${engine}: ${u.priceId}`)
      }
    }
  })

  test('an exact model price wins over the provider wildcard', ({ assert }) => {
    const m = clone()
    assert.equal(priceFor(m, 'sarvam', 'bulbul:v3', 'characters')?.id, 'sarvam-tts-v3')
    assert.equal(priceFor(m, 'sarvam', 'bulbul:v2', 'characters')?.id, 'sarvam-tts-v2')
    assert.equal(priceFor(m, 'sarvam', 'saaras:v3-realtime', 'audio_seconds')?.id, 'sarvam-stt')
    assert.equal(priceFor(m, 'livekit', '', 'participant_seconds')?.id, 'livekit')
    assert.isNull(priceFor(m, 'sarvam', 'bulbul:v9', 'characters'))
    assert.isNull(priceFor(m, 'openai', 'gpt', 'input_tokens'))
  })

  test('official prices (checked 29 Oct 2026): Sarvam per minute and per 1,000 characters', ({ assert }) => {
    const m = clone()
    const inr = (provider: string, model: string, unit: string, qty: number) => unitPriceInr(priceFor(m, provider, model, unit, '2026-10-28')!, m.usdToInr) * qty
    assert.closeTo(inr('sarvam', 'saaras:v3-realtime', 'audio_seconds', 60), 0.49, 1e-9)
    assert.closeTo(inr('sarvam', 'bulbul:v4-flash', 'characters', 1000), 2, 1e-9) // standard price, not the launch offer
    assert.closeTo(inr('sarvam', 'bulbul:v4-flash', 'characters', 10_000), 20, 1e-9)
    assert.closeTo(inr('sarvam', 'bulbul:v3', 'characters', 1000), 3, 1e-9)
    // Gemini TTS audio: Google's own "$0.0015 per 10 s"
    assert.closeTo(priceFor(m, 'google', 'gemini-3.8-flash-lite-tts', 'output_audio_seconds', '2026-10-28')!.price / 1000 * 10, 0.0015, 1e-12)
    assert.equal(m.usdToInr, 95.2)
  })

  test('a dated price takes over on its day; earlier classes keep the old price', ({ assert }) => {
    const m = clone()
    assert.equal(priceFor(m, 'google', 'gemini-3.8-flash-lite-tts', 'output_audio_seconds', '2026-12-31')?.id, 'gtts-audio')
    assert.equal(priceFor(m, 'google', 'gemini-3.8-flash-lite-tts', 'output_audio_seconds', '2027-01-01')?.id, 'gtts-audio-2027')
    assert.equal(priceFor(m, 'google', 'gemini-3.8-flash-lite-tts', 'characters', '2027-03-01')?.id, 'gtts-text-2027')
    // Estimates name the first line and follow the date too
    assert.equal(lineFor(m, 'gtts-audio', '2027-02-01')?.id, 'gtts-audio-2027')
    const before = perMinuteInr(m, '2026-12-31').global.total
    const after = perMinuteInr(m, '2027-01-01').global.total
    assert.isAbove(after, before)
    // A dated line before any undated one: the earliest applies before it starts
    const early = clone()
    early.prices = early.prices.filter((p) => p.id !== 'gtts-audio')
    assert.equal(priceFor(early, 'google', 'gemini-3.8-flash-lite-tts', 'output_audio_seconds', '2026-01-01')?.id, 'gtts-audio-2027')
  })

  test('a saved price list gets the default lines it lacks, keeps its own values, and knows it is outdated', ({ assert }) => {
    const old = clone()
    old.basedOn = undefined
    old.usdToInr = 88
    old.prices = old.prices.filter((p) => p.id !== 'sarvam-tts-v4-flash').map((p) => (p.id === 'sarvam-tts-v3' ? { ...p, price: 2.5 } : p))
    const merged = withNewDefaults(old)
    assert.equal(priceFor(merged, 'sarvam', 'bulbul:v4-flash', 'characters')?.id, 'sarvam-tts-v4-flash', 'a new voice is priced, not ₹0')
    assert.equal(merged.prices.find((p) => p.id === 'sarvam-tts-v3')!.price, 2.5, "Finance's value stays")
    assert.isTrue(modelStatus(merged).outdated)
    assert.isFalse(modelStatus(clone()).outdated)

    const custom = { ...merged, prices: [...merged.prices, { id: 'openai-x', label: 'Custom', provider: 'openai', model: '*', unit: 'input_tokens', price: 1, currency: 'USD' as const, per: 1_000_000 }] }
    const latest = withLatestPrices(custom)
    assert.equal(latest.usdToInr, DEFAULT_COST_MODEL.usdToInr)
    assert.equal(latest.prices.find((p) => p.id === 'sarvam-tts-v3')!.price, 3)
    assert.exists(latest.prices.find((p) => p.id === 'openai-x'), 'custom lines stay')
    assert.isFalse(modelStatus(latest).outdated)
    assert.doesNotThrow(() => validateCostModel(latest))
  })

  test('per-minute estimates are plausible (₹0.5–₹5)', ({ assert }) => {
    const rates = perMinuteInr(clone())
    for (const engine of ENGINES) {
      assert.isAbove(rates[engine].total, 0.5, engine)
      assert.isBelow(rates[engine].total, 5, engine)
    }
  })

  test('validation refuses negative prices, duplicates and dangling estimates', ({ assert }) => {
    const negative = clone()
    negative.prices[0].price = -1
    assert.throws(() => validateCostModel(negative))

    const duplicate = clone()
    duplicate.prices.push({ ...duplicate.prices[0], id: 'copy' })
    assert.throws(() => validateCostModel(duplicate))

    const dated = clone()
    dated.prices.push({ ...dated.prices[0], id: 'copy', from: '2027-04-01' })
    assert.doesNotThrow(() => validateCostModel(dated), 'the same key with a later from date is a price change')
    const badDate = clone()
    badDate.prices[0].from = '1 April'
    assert.throws(() => validateCostModel(badDate))

    const dangling = clone()
    dangling.assumptions.sarvam.usage.push({ priceId: 'nope', perMinute: 1 })
    assert.throws(() => validateCostModel(dangling))

    const zeroPer = clone()
    zeroPer.prices[0].per = 0
    assert.throws(() => validateCostModel(zeroPer))
  })

  test('engine estimate from the taught language', ({ assert }) => {
    assert.equal(estimateEngine('kn-IN', 'sarvam'), 'sarvam')
    assert.equal(estimateEngine('es-ES', 'sarvam'), 'global')
    assert.equal(estimateEngine(null, 'gemini'), 'gemini')
  })
})
