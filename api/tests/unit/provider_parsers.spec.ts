import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { OpenAiUsageClient, parseCompletionsUsage, parseCosts, type FetchLike } from '#services/analytics/openai_usage'
import { BillingReader, billingQuery, isSpeechSku, parseBillingRows, validTable, validTables } from '#services/analytics/gcp_billing'
import { readProviderConfig } from '#services/analytics/provider_sync'
import { ProviderError } from '#services/analytics/provider_types'

/**
 * The provider clients on fixtures shaped like the providers' documented responses
 * (OpenAI Usage/Costs API reference; GCP standard usage cost export schema). No network.
 */
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../fixtures/providers/${name}`, import.meta.url), 'utf8'))

function fakeFetch(pages: Record<string, unknown[]>, calls: string[], status = 200): FetchLike {
  const served: Record<string, number> = {}
  return async (url, init) => {
    calls.push(`${url} ${init?.headers?.Authorization ?? ''}`)
    const path = new URL(url).pathname
    const i = served[path] ?? 0
    served[path] = i + 1
    const body = status === 200 ? pages[path][i] : { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }
    return { ok: status === 200, status, text: async () => JSON.stringify(body) }
  }
}

test.group('OpenAI Usage and Costs APIs', () => {
  test('usage buckets become IST-dated rows; input is the uncached part', async ({ assert }) => {
    const rows = parseCompletionsUsage([await fixture('openai_usage_completions_page1.json'), await fixture('openai_usage_completions_page2.json')])
    const get = (day: string, unit: string) => rows.find((r) => r.day === day && r.unit === unit)
    // 2026-10-27 00:00 UTC is 05:30 IST on the 27th
    assert.equal(get('2026-10-27', 'input_tokens')?.quantity, 100_000, '120K input incl. 20K cached')
    assert.equal(get('2026-10-27', 'cached_input_tokens')?.quantity, 20_000)
    assert.equal(get('2026-10-27', 'output_tokens')?.quantity, 9000)
    assert.equal(get('2026-10-27', 'requests')?.quantity, 60)
    assert.equal(get('2026-10-28', 'input_tokens')?.quantity, 50_000, 'input_uncached_tokens used when present')
    assert.equal(get('2026-10-27', 'input_tokens')?.scope, 'proj_quizbackend/key_quizserver')
    assert.equal(get('2026-10-27', 'input_tokens')?.item, 'gpt-4o-mini-2024-07-18')
    assert.isTrue(rows.every((r) => r.source === 'openai_usage_api' && r.provider === 'openai' && r.costUsd === 0))
    assert.notExists(rows.find((r) => r.item === 'gpt-3.5-turbo-0125'), 'all-zero results are dropped')
  })

  test('costs keep OpenAI’s own USD per line item; an ungrouped result still counts', async ({ assert }) => {
    const rows = parseCosts([await fixture('openai_costs.json')])
    const day27 = rows.filter((r) => r.day === '2026-10-27')
    assert.lengthOf(day27, 3)
    assert.closeTo(day27.reduce((s, r) => s + r.costUsd, 0), 0.0219, 1e-9)
    assert.equal(day27.find((r) => r.item.endsWith(', input'))?.unit, 'tokens')
    const day28 = rows.find((r) => r.day === '2026-10-28')!
    assert.equal(day28.item, 'all line items')
    assert.equal(day28.scope, 'all-projects')
    assert.equal(day28.unit, 'usd')
    assert.equal(day28.costUsd, 0.06)
    assert.throws(() => parseCosts([{ data: [{ start_time: 1793059200, results: [{ object: 'organization.costs.result', amount: { value: 1, currency: 'eur' } }] }] }]))
  })

  test('the client pages through next_page, filters to the quiz project/keys, and sends the admin key', async ({ assert }) => {
    const calls: string[] = []
    const client = new OpenAiUsageClient({
      adminKey: 'sk-admin-test',
      projectIds: ['proj_quizbackend'],
      apiKeyIds: ['key_quizserver'],
      fetch: fakeFetch(
        {
          '/v1/organization/usage/completions': [await fixture('openai_usage_completions_page1.json'), await fixture('openai_usage_completions_page2.json')],
          '/v1/organization/costs': [await fixture('openai_costs.json')],
        },
        calls
      ),
    })
    const usage = await client.completions(1793059200, 3)
    const costs = await client.costs(1793059200, 3)
    assert.lengthOf(calls, 3)
    const first = new URL(calls[0].split(' ')[0])
    assert.equal(first.searchParams.get('bucket_width'), '1d')
    assert.equal(first.searchParams.get('start_time'), '1793059200')
    assert.deepEqual(first.searchParams.getAll('group_by[]'), ['model', 'project_id', 'api_key_id'])
    assert.deepEqual(first.searchParams.getAll('project_ids[]'), ['proj_quizbackend'])
    assert.deepEqual(first.searchParams.getAll('api_key_ids[]'), ['key_quizserver'])
    assert.equal(new URL(calls[1].split(' ')[0]).searchParams.get('page'), 'page_AAAAAGdGxdEiJdKOAAAAAGcqsYA=')
    assert.isTrue(calls.every((c) => c.endsWith('Bearer sk-admin-test')))
    assert.isAbove(usage.length, 4)
    assert.lengthOf(costs.rows, 4)
    assert.isTrue(costs.byKey)
    assert.deepEqual(new URL(calls[2].split(' ')[0]).searchParams.getAll('group_by[]'), ['project_id', 'line_item', 'api_key_id'])
  })

  test('a rejected key is a ProviderError that never echoes the key', async ({ assert }) => {
    const client = new OpenAiUsageClient({ adminKey: 'sk-admin-secret', fetch: fakeFetch({}, [], 401) })
    try {
      await client.costs(1793059200, 1)
      assert.fail('expected an error')
    } catch (error) {
      assert.instanceOf(error, ProviderError)
      assert.equal((error as ProviderError).status, 401)
      assert.include((error as Error).message, 'Admin key')
      assert.notInclude((error as Error).message, 'sk-admin-secret')
    }
  })
})

test.group('GCP billing export', () => {
  test('rows: every project, IST day, service / SKU, gross and credits apart, and how far the export has got', async ({ assert }) => {
    const { rows, dataThrough, exportedAt } = parseBillingRows(await fixture('gcp_billing_rows.json'))
    assert.lengthOf(rows, 6)
    const v1 = rows.find((r) => r.item.endsWith('Speech Recognition (without data logging)'))!
    assert.closeTo(v1.costUsd, 0.24, 1e-9, 'gross')
    assert.closeTo(v1.creditsUsd, -0.04, 1e-9, 'credits kept apart: net = gross + credits')
    assert.deepEqual([...new Set(rows.map((r) => r.scope))].sort(), ['multibhashi-android-app', 'multibhashi-web', 'no-project'])
    assert.equal(rows.find((r) => r.scope === 'no-project')?.unit, 'none')
    assert.equal(v1.unit, 'seconds')
    assert.equal(v1.scope, 'multibhashi-android-app')
    assert.equal(v1.source, 'gcp_billing_export')
    assert.equal(dataThrough, '2026-10-28T23:00:00.000Z')
    assert.equal(exportedAt, '2026-10-29T03:40:00.000Z')
  })

  test('speech SKUs: the price page names and the names the real export bills', ({ assert }) => {
    assert.isTrue(isSpeechSku('Any service / Recognition'))
    assert.isTrue(isSpeechSku('Any service / Speech Recognition (with data logging)'))
    assert.isTrue(isSpeechSku('Any service / Dynamic Batch Recognition'))
    // As billed to this account (FOCUS export, checked 30 Oct 2026).
    assert.isTrue(isSpeechSku('Cloud Speech API / Cloud Speech-to-Text Audio Length Standard'))
    assert.isTrue(isSpeechSku('Cloud Speech API / Something renamed later'), 'the Cloud Speech API service itself')
    assert.isFalse(isSpeechSku('Any service / Standard Storage Mumbai'))
    assert.isFalse(isSpeechSku('Recognition API / Network egress'))
    assert.isFalse(isSpeechSku('Cloud Text-to-Speech API / Neural2 voices'), 'text-to-speech is not speech-to-text')
  })

  test('several export tables: each day comes from the most complete source; a not-yet-created table is empty', async ({ assert }) => {
    const standard = 'multibhashi-android-app.bilin23.gcp_billing_export_v1_016513_594D05_0EF1D5'
    const focus = 'multibhashi-android-app.gcp_billing_immutable_016513_594D05_0EF1D5_us.gcp_billing_export_focus_016513_594D05_0EF1D5'
    assert.isTrue(validTables(`${standard}, ${focus}`))
    assert.isFalse(validTables(`${standard}, x\`; DROP TABLE y`))
    const day = (d: string, cost: number, sku = 'Standard Storage') => ({ usage_day: d, project_id: 'p', service: 'Cloud Storage', sku, unit: 'gibibytes', quantity: 1, cost_usd: cost, credits_usd: 0 })
    const answer: Record<string, unknown[]> = {
      // Standard export: enabled on the 30th, so a partial first day and a whole 31st.
      [standard]: [day('2026-10-30', 0.4), day('2026-10-31', 5)],
      // FOCUS: history up to and including the whole 30th.
      [focus]: [day('2026-09-25', 3), day('2026-10-30', 4), day('2026-10-30', 1, 'Download')],
    }
    const queried: string[] = []
    const reader = new BillingReader({
      table: `${standard},${focus}`,
      client: { query: async ({ query }) => { const t = Object.keys(answer).find((k) => query.includes(`\`${k}\``))!; queried.push(t); return [answer[t]] } },
    })
    const result = await reader.read('2026-09-01')
    assert.deepEqual(queried, [standard, focus])
    const byDay = (d: string) => result.rows.filter((r) => r.day === d)
    assert.lengthOf(byDay('2026-09-25'), 1, 'history only FOCUS has')
    assert.deepEqual(byDay('2026-10-30').map((r) => r.costUsd).sort(), [1, 4], 'the whole day from FOCUS, never mixed with the partial standard day')
    assert.deepEqual(byDay('2026-10-31').map((r) => r.costUsd), [5], 'current days from the standard export')

    const missing = new BillingReader({
      table: `${standard},${focus}`,
      client: { query: async ({ query }) => { if (query.includes('bilin23')) throw Object.assign(new Error('Not found: Table multibhashi-android-app:bilin23.gcp_billing_export_v1_016513_594D05_0EF1D5'), { code: 404 }); return [answer[focus]] } },
    })
    assert.lengthOf((await missing.read('2026-09-01')).rows, 3, 'the standard table not created yet: FOCUS alone')
    const alone = new BillingReader({ table: standard, client: { query: async () => { throw Object.assign(new Error('Not found: Table x'), { code: 404 }) } } })
    // A single missing table is still an error.
    await assert.rejects(() => alone.read('2026-09-01'), /Not found/)
  })

  test('storage byte-seconds and egress bytes become GiB-days and GiB, so they fit the quantity column', ({ assert }) => {
    // The real maximum on this account, 30 Oct 2026, that overflowed DECIMAL(20,4).
    const [stored, egress, speech] = parseBillingRows([
      { usage_day: '2026-09-11', project_id: 'p', service: 'Cloud Storage', sku: 'Standard Storage Mumbai', unit: 'byte-seconds', quantity: 2.0521774597977907e18, cost_usd: 1, credits_usd: 0 },
      { usage_day: '2026-09-11', project_id: 'p', service: 'Cloud Storage', sku: 'Download Worldwide', unit: 'bytes', quantity: 10763075876, cost_usd: 0, credits_usd: 0 },
      { usage_day: '2026-09-11', project_id: 'p', service: 'Cloud Speech API', sku: 'Cloud Speech-to-Text Audio Length Standard', unit: 'seconds', quantity: 1234.5, cost_usd: 0.5, credits_usd: 0 },
    ]).rows
    assert.equal(stored.unit, 'gibibyte-days')
    assert.closeTo(stored.quantity, 22120.82, 0.1)
    assert.isBelow(stored.quantity, 1e15)
    assert.equal(egress.unit, 'gibibytes')
    assert.closeTo(egress.quantity, 10.02, 0.01)
    assert.deepEqual([speech.unit, speech.quantity], ['seconds', 1234.5], 'other units are untouched')
  })

  test('a FOCUS-format table is read with the FOCUS columns; credits come back out of the net BilledCost', async ({ assert }) => {
    const table = 'multibhashi-android-app.gcp_billing_immutable_016513_594D05_0EF1D5_us.gcp_billing_export_focus_016513_594D05_0EF1D5'
    assert.isTrue(validTable(table))
    let seen: { query: string; params?: Record<string, unknown> } | null = null
    const reader = new BillingReader({
      table,
      client: {
        query: async (options) => {
          seen = options
          // ₹9,292.59 net of ₹-1.00 credits at 95.6 INR/USD, as the query returns it (already in USD).
          return [[{ usage_day: '2026-09-25', project_id: 'multibhashi-android-app', service: 'Cloud Speech API', sku: 'Cloud Speech-to-Text Audio Length Standard', unit: 'seconds', quantity: 246747, cost_usd: 97.21, credits_usd: -0.01, usage_through: { value: '2026-09-25T19:00:00Z' }, exported_at: { value: '2026-09-26T03:00:00Z' } }]]
        },
      },
    })
    const result = await reader.read('2026-08-01')
    for (const column of ['BilledCost', 'x_Credits', 'x_CurrencyConversionRate', 'x_Project.Id', 'ChargeDescription', 'ConsumedQuantity', "DATE(ChargePeriodStart, 'Asia/Kolkata')"]) {
      assert.include(seen!.query, column)
    }
    assert.notInclude(seen!.query, 'usage_start_time')
    assert.deepEqual(seen!.params, { since_day: '2026-08-01' })
    assert.lengthOf(result.rows, 1)
    assert.equal(result.rows[0].item, 'Cloud Speech API / Cloud Speech-to-Text Audio Length Standard')
    assert.isTrue(isSpeechSku(result.rows[0].item))
    assert.equal(result.dataThrough, '2026-09-25T19:00:00.000Z')
  })

  test('the table id is validated before it reaches SQL; the whole account is read (only the day is a parameter)', async ({ assert }) => {
    assert.isTrue(validTable('mb-billing.billing_export.gcp_billing_export_v1_016513_594D05_0EF1D5'))
    assert.isFalse(validTable('x`; DROP TABLE y; --'))
    assert.throws(() => billingQuery('not a table'))
    let seen: { query: string; params?: Record<string, unknown> } | null = null
    const reader = new BillingReader({
      table: 'mb-billing.billing_export.gcp_billing_export_v1_016513_594D05_0EF1D5',
      client: {
        query: async (options) => {
          seen = options
          return [await fixture('gcp_billing_rows.json')]
        },
      },
    })
    const result = await reader.read('2026-10-23')
    assert.lengthOf(result.rows, 6)
    assert.deepEqual(seen!.params, { since_day: '2026-10-23' })
    assert.notInclude(seen!.query, '@project', 'no project filter: the whole billing account')
    assert.include(seen!.query, "IFNULL(project.id, 'no-project')")
    assert.include(seen!.query, '`mb-billing.billing_export.gcp_billing_export_v1_016513_594D05_0EF1D5`')
    assert.include(seen!.query, 'UNNEST(credits)')
    assert.include(seen!.query, "DATE(usage_start_time, 'Asia/Kolkata')")
  })

  test('a BigQuery failure becomes a ProviderError', async ({ assert }) => {
    const reader = new BillingReader({
      table: 'a-proj.ds.gcp_billing_export_v1_X',
      client: { query: async () => Promise.reject(Object.assign(new Error('Access Denied: Table a-proj:ds.t'), { code: 403 })) },
    })
    await assert.rejects(() => reader.read('2026-10-23'), /BigQuery: Access Denied/)
  })
})

test.group('Provider configuration', () => {
  test('nothing set: both "not connected", with the missing settings named', async ({ assert }) => {
    const cfg = await readProviderConfig(() => undefined)
    assert.isFalse(cfg.openai.connected)
    assert.deepEqual(cfg.openai.missing, ['OPENAI_ADMIN_KEY'])
    assert.isFalse(cfg.google.connected)
    assert.lengthOf(cfg.google.missing, 2, 'GCP_SPEECH_PROJECT_ID is an attribution rule, not needed to connect')
  })

  test('filters and credentials parse (raw or base64 JSON); a bad table is a problem, not a crash', async ({ assert }) => {
    const key = { project_id: 'p', client_email: 'sa@p.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' }
    const env: Record<string, string> = {
      OPENAI_ADMIN_KEY: 'sk-admin',
      OPENAI_QUIZ_PROJECT_ID: 'proj_a',
      OPENAI_QUIZ_API_KEY_IDS: 'key_1, key_2,',
      GCP_BILLING_CREDENTIALS_JSON: Buffer.from(JSON.stringify(key)).toString('base64'),
      GCP_BILLING_EXPORT_TABLE: 'mb-billing.billing_export.gcp_billing_export_v1_016513_594D05_0EF1D5',
      GCP_SPEECH_PROJECT_ID: 'multibhashi-android-app',
    }
    const cfg = await readProviderConfig((k) => env[k])
    assert.isTrue(cfg.openai.connected)
    assert.deepEqual(cfg.openai.projectIds, ['proj_a'])
    assert.deepEqual(cfg.openai.apiKeyIds, ['key_1', 'key_2'])
    assert.isTrue(cfg.google.connected)
    assert.equal(cfg.google.credentials?.client_email, key.client_email)

    const bad = await readProviderConfig((k) => ({ ...env, GCP_BILLING_EXPORT_TABLE: 'nope', GCP_BILLING_CREDENTIALS_JSON: '{not json' })[k])
    assert.isFalse(bad.google.connected)
    assert.isString(bad.google.problem)
    assert.notInclude(String(bad.google.problem), 'not json')
  })
})
