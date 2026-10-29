import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { OpenAiUsageClient, parseCompletionsUsage, parseCosts, type FetchLike } from '#services/analytics/openai_usage'
import { BillingReader, billingQuery, isSpeechSku, parseBillingRows, validTable } from '#services/analytics/gcp_billing'
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
    assert.deepEqual(new URL(calls[2].split(' ')[0]).searchParams.getAll('group_by[]'), ['project_id', 'line_item'])
    assert.isTrue(calls.every((c) => c.endsWith('Bearer sk-admin-test')))
    assert.isAbove(usage.length, 4)
    assert.lengthOf(costs, 4)
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
  test('rows: IST day, service / SKU, net cost in USD, and how far the export has got', async ({ assert }) => {
    const { rows, dataThrough, exportedAt } = parseBillingRows(await fixture('gcp_billing_rows.json'))
    assert.lengthOf(rows, 4)
    const v1 = rows.find((r) => r.item.endsWith('Speech Recognition (without data logging)'))!
    assert.closeTo(v1.costUsd, 0.2, 1e-9, 'cost + credits')
    assert.equal(v1.unit, 'seconds')
    assert.equal(v1.scope, 'multibhashi-android-app')
    assert.equal(v1.source, 'gcp_billing_export')
    assert.equal(dataThrough, '2026-10-28T23:00:00.000Z')
    assert.equal(exportedAt, '2026-10-29T03:40:00.000Z')
  })

  test('speech SKUs are matched by the names on Google’s Speech-to-Text price page, not a service name', ({ assert }) => {
    assert.isTrue(isSpeechSku('Any service / Recognition'))
    assert.isTrue(isSpeechSku('Any service / Speech Recognition (with data logging)'))
    assert.isTrue(isSpeechSku('Any service / Dynamic Batch Recognition'))
    assert.isFalse(isSpeechSku('Any service / Standard Storage Mumbai'))
    assert.isFalse(isSpeechSku('Recognition API / Network egress'), 'the service part is ignored')
  })

  test('the table id is validated before it reaches SQL; the project and day are parameters', async ({ assert }) => {
    assert.isTrue(validTable('mb-billing.billing_export.gcp_billing_export_v1_016513_594D05_0EF1D5'))
    assert.isFalse(validTable('x`; DROP TABLE y; --'))
    assert.throws(() => billingQuery('not a table'))
    let seen: { query: string; params?: Record<string, unknown> } | null = null
    const reader = new BillingReader({
      table: 'mb-billing.billing_export.gcp_billing_export_v1_016513_594D05_0EF1D5',
      projectId: 'multibhashi-android-app',
      client: {
        query: async (options) => {
          seen = options
          return [await fixture('gcp_billing_rows.json')]
        },
      },
    })
    const result = await reader.read('2026-10-23')
    assert.lengthOf(result.rows, 4)
    assert.deepEqual(seen!.params, { project: 'multibhashi-android-app', since_day: '2026-10-23' })
    assert.include(seen!.query, '`mb-billing.billing_export.gcp_billing_export_v1_016513_594D05_0EF1D5`')
    assert.include(seen!.query, 'UNNEST(credits)')
    assert.include(seen!.query, "DATE(usage_start_time, 'Asia/Kolkata')")
  })

  test('a BigQuery failure becomes a ProviderError', async ({ assert }) => {
    const reader = new BillingReader({
      table: 'a-proj.ds.gcp_billing_export_v1_X',
      projectId: 'multibhashi-android-app',
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
    assert.lengthOf(cfg.google.missing, 3)
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
