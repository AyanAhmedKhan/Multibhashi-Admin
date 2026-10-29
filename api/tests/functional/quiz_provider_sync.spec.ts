import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import db from '@adonisjs/lucid/services/db'
import providerSync, { type ProviderConfig } from '#services/analytics/provider_sync'
import type { FetchLike } from '#services/analytics/openai_usage'

/**
 * The provider sync against the local database, with OpenAI and BigQuery replaced by
 * fixtures (no network). Whatever console_ai_provider_daily and the sync status held
 * before (demo rows) is put back afterwards.
 */
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../fixtures/providers/${name}`, import.meta.url), 'utf8'))
const NOW = Date.parse('2026-10-29T10:00:00+05:30')

const config: ProviderConfig = {
  openai: { connected: true, missing: [], adminKey: 'sk-admin-fixture', projectIds: ['proj_quizbackend'], apiKeyIds: [] },
  google: {
    connected: true,
    missing: [],
    table: 'mb-billing.billing_export.gcp_billing_export_v1_016513_594D05_0EF1D5',
    projectId: 'multibhashi-android-app',
    credentials: { client_email: 'fixture@example.test', private_key: 'fixture' },
  },
}

async function fakeOpenAi(): Promise<FetchLike> {
  const pages: Record<string, unknown[]> = {
    '/v1/organization/usage/completions': [await fixture('openai_usage_completions_page1.json'), await fixture('openai_usage_completions_page2.json')],
    '/v1/organization/costs': [await fixture('openai_costs.json')],
  }
  const served: Record<string, number> = {}
  return async (url) => {
    const path = new URL(url).pathname
    const i = served[path] ?? 0
    served[path] = i + 1
    return { ok: true, status: 200, text: async () => JSON.stringify(pages[path][i % pages[path].length]) }
  }
}

test.group('Quiz provider sync', (group) => {
  let saved: Record<string, unknown>[] = []
  let status: Record<string, unknown> | null = null
  group.setup(async () => {
    saved = await db.from('console_ai_provider_daily').select('*')
    status = (await db.from('console_settings').where('key', 'quiz_provider_sync').first()) ?? null
  })
  group.teardown(async () => {
    await db.from('console_ai_provider_daily').delete()
    for (let i = 0; i < saved.length; i += 500) {
      await db.table('console_ai_provider_daily').multiInsert(saved.slice(i, i + 500).map(({ id: _id, ...row }) => row))
    }
    await db.from('console_settings').where('key', 'quiz_provider_sync').delete()
    if (status) await db.table('console_settings').insert(status)
  })

  test('a window syncs idempotently: the same rows after a second run, stale rows removed', async ({ assert }) => {
    const bigquery = { query: async () => [await fixture('gcp_billing_rows.json')] }
    // A stale row inside the window that the provider no longer reports
    await db.table('console_ai_provider_daily').insert({
      day: '2026-10-28',
      provider: 'google',
      scope: 'multibhashi-android-app',
      item: 'Old service / Old SKU',
      unit: 'seconds',
      quantity: 1,
      cost_usd: 9,
      source: 'gcp_billing_export',
      synced_at: new Date(NOW - 86_400_000),
    })
    const count = async () => (await db.from('console_ai_provider_daily').where('day', '>=', '2026-10-27').where('day', '<=', '2026-10-29').count('* as n'))[0].n
    const first = await providerSync.run(3, { config, fetch: await fakeOpenAi(), bigquery, now: NOW })
    assert.isTrue('ok' in first.openai && first.openai.ok, JSON.stringify(first.openai))
    assert.isTrue('ok' in first.google && first.google.ok, JSON.stringify(first.google))
    const afterFirst = Number(await count())
    const second = await providerSync.run(3, { config, fetch: await fakeOpenAi(), bigquery, now: NOW })
    assert.isTrue('ok' in second.google && second.google.ok)
    assert.equal(Number(await count()), afterFirst, 'no duplicates on a re-run')
    assert.notExists(await db.from('console_ai_provider_daily').where('item', 'Old service / Old SKU').first(), 'stale row removed')

    const speech = await db.from('console_ai_provider_daily').where('provider', 'google').where('day', '2026-10-27').sum('cost_usd as usd').first()
    assert.closeTo(Number(speech.usd), 1.64, 1e-6)
    const openaiCost = await db.from('console_ai_provider_daily').where('source', 'openai_costs_api').where('day', '2026-10-27').sum('cost_usd as usd').first()
    assert.closeTo(Number(openaiCost.usd), 0.0219, 1e-6)

    const st = await providerSync.status({ ...config })
    assert.isTrue(st.openai.connected)
    assert.equal(st.google.lastRun?.dataThrough, '2026-10-28T23:00:00.000Z')
    assert.notProperty(st.google, 'credentials', 'credentials never leave the server')
  })

  test('a provider error keeps the previous rows and reports the error', async ({ assert }) => {
    const before = Number((await db.from('console_ai_provider_daily').where('provider', 'google').count('* as n'))[0].n)
    const failing = { query: async () => Promise.reject(Object.assign(new Error('Access Denied'), { code: 403 })) }
    const res = await providerSync.run(3, { config: { ...config, openai: { ...config.openai, connected: false, missing: ['OPENAI_ADMIN_KEY'] } }, bigquery: failing, now: NOW })
    assert.isTrue('connected' in res.openai, 'openai not connected is a status')
    assert.isTrue('ok' in res.google && !res.google.ok)
    assert.include('error' in res.google ? String(res.google.error) : '', 'Access Denied')
    assert.equal(Number((await db.from('console_ai_provider_daily').where('provider', 'google').count('* as n'))[0].n), before)
  })
})
