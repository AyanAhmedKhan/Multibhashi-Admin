import { test } from '@japa/runner'
import { FACT_TABLES } from '#services/product_analytics/ddl'
import { SETTLED, deleteSql, forgetLearner, forgetTargets, parseSubject, resolveIds } from '#services/product_analytics/forget'
import { withoutForgotten } from '#services/product_analytics/facts'
import { Refs } from '#services/product_analytics/warehouse'
import { FakeWarehouse } from '#tests/unit/helpers/fake_warehouse'

const r = new Refs('test-project-123', 'product_analytics')
const APPSPOT = '64ab0c1d2e3f405162738495'

/** A BigQuery that knows one learner: appspot id ↔ td 4567, with two devices. */
function learnerWarehouse(over: { missing?: string[]; fail?: string } = {}) {
  return new FakeWarehouse((sql) => {
    for (const t of over.missing ?? []) if (sql.includes(`.${t}\``)) throw Object.assign(new Error(`Not found: Table test-project-123:product_analytics.${t}`), { code: 404 })
    if (over.fail && sql.includes(over.fail)) throw new Error('Access Denied')
    if (sql.startsWith('SELECT appspot_id, td_user_id')) return [{ appspot_id: APPSPOT, td_user_id: 4567 }]
    if (sql.startsWith('SELECT anonymous_id')) return [{ anonymous_id: 'dev-1' }, { anonymous_id: 'dev-2' }]
    if (sql.startsWith('SELECT COUNT(*)')) return [{ n: 3 }]
    if (sql.startsWith('DELETE')) return [{ affected: 5 }]
    return []
  })
}

test.group('analytics:forget-user (MUL-153)', () => {
  test('takes a teachers-dashboard id (digits) or an appspot _id, nothing else', ({ assert }) => {
    assert.deepEqual(parseSubject('4567'), { kind: 'td', id: 4567 })
    assert.deepEqual(parseSubject(` ${APPSPOT} `), { kind: 'appspot', id: APPSPOT })
    for (const bad of ['', "4567' OR 1=1", 'a b', '+919876543210', 'x'.repeat(65)]) assert.throws(() => parseSubject(bad), /users\.id/)
  })

  test('covers the events, every fact, identities and the person-level models; aggregates hold no id', ({ assert }) => {
    const tables = forgetTargets().map((t) => t.table)
    assert.includeMembers(tables, ['events_raw', 'events_dev', ...FACT_TABLES, 'm_sessions', 'm_funnel_steps', 'm_user_firsts', 'm_identity_links'])
    for (const aggregate of ['m_screen_daily', 'm_feature_daily', 'm_retention_weekly', 'm_health_daily']) assert.notInclude(tables, aggregate)
    // The links are read to find the devices: they go last.
    assert.equal(tables[tables.length - 1], 'm_identity_links')
  })

  test('events: the learner’s rows and their devices’ anonymous rows only, past the streaming buffer', ({ assert }) => {
    const events = forgetTargets().find((t) => t.table === 'events_raw')!
    assert.equal(
      deleteSql(r, events),
      `DELETE FROM \`test-project-123.product_analytics.events_raw\` WHERE (user_id IN UNNEST(@appspot_ids) OR (user_id IS NULL AND anonymous_id IN UNNEST(@anonymous_ids))) AND ${SETTLED}`
    )
    assert.equal(SETTLED, "event_date < DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY)")
    for (const t of forgetTargets()) assert.match(t.where, /UNNEST\(@(appspot_ids|td_user_ids|anonymous_ids|persons)\)/, t.table)
  })

  test('resolves the other id through identities and MySQL accounts, and the device ids', async ({ assert }) => {
    const bq = learnerWarehouse()
    const ids = await resolveIds({ kind: 'td', id: 4567 }, { warehouse: bq, refs: r, accounts: async () => ({ appspotIds: ['legacy-app-id-1'], tdUserIds: [] }) })
    assert.sameMembers(ids.appspotIds, [APPSPOT, 'legacy-app-id-1'])
    assert.deepEqual(ids.tdUserIds, [4567])
    assert.deepEqual(ids.anonymousIds, ['dev-1', 'dev-2'])
    // Typed arrays: an empty list must still bind.
    assert.deepEqual(bq.queries[0].types, { appspot_ids: ['STRING'], td_user_ids: ['INT64'], anonymous_ids: ['STRING'], persons: ['STRING'] })
  })

  test('deletes table by table with the resolved ids and reports the counts', async ({ assert }) => {
    const bq = learnerWarehouse()
    const result = await forgetLearner({ kind: 'appspot', id: APPSPOT }, { warehouse: bq, refs: r, dryRun: false })
    const deletes = bq.queries.filter((q) => q.sql.startsWith('DELETE'))
    assert.lengthOf(deletes, forgetTargets().length)
    assert.deepEqual(deletes[0].params, {
      appspot_ids: [APPSPOT],
      td_user_ids: [4567],
      anonymous_ids: ['dev-1', 'dev-2'],
      persons: [APPSPOT, 'anon:dev-1', 'anon:dev-2'],
    })
    assert.isTrue(result.tables.every((t) => t.rows === 5))
    assert.isFalse(result.dryRun)
  })

  test('a dry run counts and deletes nothing', async ({ assert }) => {
    const bq = learnerWarehouse()
    const result = await forgetLearner({ kind: 'td', id: 4567 }, { warehouse: bq, refs: r, dryRun: true })
    assert.isFalse(bq.sql.some((s) => s.startsWith('DELETE')))
    assert.isTrue(result.tables.every((t) => t.rows === 3))
  })

  test('a table that does not exist yet is skipped; any other error stops the run', async ({ assert }) => {
    const result = await forgetLearner({ kind: 'td', id: 4567 }, { warehouse: learnerWarehouse({ missing: ['events_dev'] }), refs: r, dryRun: false })
    assert.equal(result.tables.find((t) => t.table === 'events_dev')!.rows, 'missing')
    assert.equal(result.tables.find((t) => t.table === 'fact_users')!.rows, 5)
    await assert.rejects(() => forgetLearner({ kind: 'td', id: 4567 }, { warehouse: learnerWarehouse({ fail: 'DELETE FROM `test-project-123.product_analytics.fact_payments`' }), refs: r, dryRun: false }), /Access Denied/)
  })

  test('forgotten learners are kept out of the next facts export', async ({ assert }) => {
    async function* pages() {
      yield [{ td_user_id: 4567 }, { td_user_id: 1 }, { appspot_id: APPSPOT, td_user_id: null }, { appspot_id: 'other-app-id', td_user_id: 2 }]
    }
    const kept: Record<string, unknown>[] = []
    for await (const page of withoutForgotten(pages(), { tdUserIds: new Set([4567]), appspotIds: new Set([APPSPOT]) })) kept.push(...page)
    assert.deepEqual(kept, [{ td_user_id: 1 }, { appspot_id: 'other-app-id', td_user_id: 2 }])
  })
})
