import { test } from '@japa/runner'
import {
  DEFAULT_COST_MODEL,
  ENGINES,
  estimateEngine,
  perMinuteInr,
  priceFor,
  unitPriceInr,
  validateCostModel,
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

  test('Sarvam prices: ₹30 per audio hour, ₹30 per 10K characters', ({ assert }) => {
    const m = clone()
    const stt = priceFor(m, 'sarvam', 'x', 'audio_seconds')!
    const tts = priceFor(m, 'sarvam', 'bulbul:v3', 'characters')!
    assert.closeTo(unitPriceInr(stt, m.usdToInr) * 3600, 30, 1e-9)
    assert.closeTo(unitPriceInr(tts, m.usdToInr) * 10_000, 30, 1e-9)
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
