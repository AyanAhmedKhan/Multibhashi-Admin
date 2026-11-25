import { test } from '@japa/runner'
import {
  EVENT_TABLES,
  EXAMPLE_PROJECT,
  FACT_TABLES,
  MODEL_TABLES,
  bqSetup,
  columnsOf,
  describeStatement,
  loadDdlFiles,
  renderSql,
  setupPlan,
  splitStatements,
} from '#services/product_analytics/ddl'
import { publicStatus, readWarehouseConfig } from '#services/product_analytics/config'
import { Refs } from '#services/product_analytics/warehouse'
import { FakeWarehouse, TEST_CONFIG } from '#tests/unit/helpers/fake_warehouse'

const VARS = { project: 'test-project-123', dataset: 'product_analytics', location: 'asia-south1' }

/** design/IMPLEMENTATION-CONTRACTS.md §5.4, column by column. */
const CONTRACT_COLUMNS = `event_id STRING, event_name STRING, event_version INT64,
event_ts TIMESTAMP, received_at TIMESTAMP, event_date DATE,
anonymous_id STRING, user_id STRING, session_id STRING,
platform STRING, app_version STRING, build STRING, os STRING, browser STRING, viewport_w INT64,
screen STRING, previous_screen STRING,
utm_source STRING, utm_medium STRING, utm_campaign STRING, referrer_domain STRING, network STRING,
country STRING, region STRING, opted_out BOOL, props JSON`
  .split(',')
  .map((c) => c.trim().split(/\s+/))
  .map(([name, type]) => ({ name, type }))

/** BigQuery reserved keywords that could plausibly be used as column names. */
const RESERVED = ['at', 'all', 'by', 'current', 'default', 'end', 'from', 'groups', 'hash', 'lookup', 'new', 'range', 'rows', 'to', 'window', 'within']

async function plan() {
  return setupPlan(await loadDdlFiles(), VARS)
}

const tableStatement = async (name: string) => {
  const statement = (await plan()).find((s) => s.kind === 'table' && s.object.endsWith(`.${name}`))
  if (!statement) throw new Error(`no CREATE TABLE for ${name}`)
  return statement.sql
}

test.group('Product analytics DDL (MUL-148)', () => {
  test('the dataset comes first, in asia-south1, and every table is created once', async ({ assert }) => {
    const p = await plan()
    assert.equal(p[0].kind, 'dataset')
    assert.equal(p[0].object, 'test-project-123.product_analytics')
    assert.include(p[0].sql, "location = 'asia-south1'")
    const created = p.filter((s) => s.kind === 'table').map((s) => s.object.split('.').pop())
    assert.sameMembers(created, [...EVENT_TABLES, ...FACT_TABLES, ...MODEL_TABLES])
    assert.equal(new Set(created).size, created.length)
  })

  test('events_raw and events_dev have exactly the contract columns, partitioning and clustering', async ({ assert }) => {
    for (const table of EVENT_TABLES) {
      const sql = await tableStatement(table)
      assert.deepEqual(columnsOf(sql), CONTRACT_COLUMNS, table)
      assert.match(sql, /\nPARTITION BY event_date\n/)
      assert.match(sql, /\nCLUSTER BY event_name, user_id\n/)
    }
  })

  test('raw events expire after 395 days, debug events after 30, and an existing table is brought in line', async ({ assert }) => {
    assert.include(await tableStatement('events_raw'), 'partition_expiration_days = 395')
    assert.include(await tableStatement('events_dev'), 'partition_expiration_days = 30')
    const alters = (await plan()).filter((s) => s.kind === 'alter')
    assert.deepEqual(
      alters.map((s) => [s.object.split('.').pop(), s.sql.match(/partition_expiration_days = (\d+)/)?.[1]]),
      [
        ['events_raw', '395'],
        ['events_dev', '30'],
      ]
    )
  })

  test('person-level models expire with the raw events; aggregates are kept', async ({ assert }) => {
    for (const t of ['m_sessions', 'm_funnel_steps']) assert.include(await tableStatement(t), 'partition_expiration_days = 395', t)
    for (const t of ['m_screen_daily', 'm_feature_daily', 'm_retention_weekly', 'm_health_daily', ...FACT_TABLES]) {
      assert.notInclude(await tableStatement(t), 'expiration', t)
    }
  })

  test('every statement is idempotent and nothing is dropped or emptied', async ({ assert }) => {
    for (const s of await plan()) {
      const code = s.sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
      assert.match(code, /^(CREATE SCHEMA IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|ALTER TABLE `[^`]+` SET OPTIONS)/, s.file)
      assert.notMatch(code, /\b(DROP|DELETE|TRUNCATE|OR REPLACE)\b/i, s.file)
    }
  })

  test('placeholders are all filled and table names are fully qualified', async ({ assert }) => {
    for (const s of await plan()) {
      assert.notInclude(s.sql, '{{', s.file)
      if (s.kind === 'table') assert.match(s.object, /^test-project-123\.product_analytics\.[a-z_]+$/)
    }
  })

  test('the facts carry the contract keys, and no column is a reserved word or personal data', async ({ assert }) => {
    const users = columnsOf(await tableStatement('fact_users')).map((c) => c.name)
    assert.includeMembers(users, ['td_user_id', 'created_at', 'verified', 'country_code', 'utm_source'])
    assert.includeMembers(columnsOf(await tableStatement('identities')).map((c) => c.name), ['appspot_id', 'td_user_id', 'learner_account_id'])
    for (const s of (await plan()).filter((x) => x.kind === 'table')) {
      for (const c of columnsOf(s.sql)) {
        assert.notInclude(RESERVED, c.name.toLowerCase(), `${s.object}.${c.name}`)
        assert.notMatch(c.name, /phone|email|e_mail|full_name|learner_name|user_name|password|token|ip_address/i, `${s.object}.${c.name}`)
      }
    }
  })

  test('renderSql validates what goes into the SQL', ({ assert }) => {
    assert.equal(renderSql('`{{project}}.{{dataset}}` {{ location }}', VARS), '`test-project-123.product_analytics` asia-south1')
    assert.throws(() => renderSql('x', { ...VARS, project: 'bad`; DROP' }), /project/)
    assert.throws(() => renderSql('x', { ...VARS, dataset: 'a.b' }), /dataset/)
    assert.throws(() => renderSql('{{secret}}', VARS), /Unknown placeholder/)
  })

  test('splitStatements keeps comments with their statement and ignores comment semicolons', ({ assert }) => {
    const sql = '-- header;\nCREATE TABLE `a` (x INT64);\n\n-- second\nALTER TABLE `a` SET OPTIONS (y = 1);\n-- trailing\n'
    const parts = splitStatements(sql)
    assert.lengthOf(parts, 2)
    assert.equal(parts[0], '-- header;\nCREATE TABLE `a` (x INT64);')
    assert.equal(parts[1], '-- second\nALTER TABLE `a` SET OPTIONS (y = 1);')
    assert.deepEqual(describeStatement(parts[1]), { kind: 'alter', object: 'a' })
  })

  test('columnsOf reads nested types', ({ assert }) => {
    assert.deepEqual(columnsOf('CREATE TABLE `t` (a INT64 NOT NULL, b ARRAY<STRUCT<s STRING, v INT64>>, c NUMERIC) PARTITION BY DATE_TRUNC(d, MONTH)'), [
      { name: 'a', type: 'INT64' },
      { name: 'b', type: 'ARRAY<STRUCT<s STRING, v INT64>>' },
      { name: 'c', type: 'NUMERIC' },
    ])
  })

  test('Refs quote validated names only', ({ assert }) => {
    const refs = new Refs('test-project-123', 'product_analytics')
    assert.equal(refs.t('events_raw'), '`test-project-123.product_analytics.events_raw`')
    assert.throws(() => refs.t('x`; DROP TABLE y'))
    assert.throws(() => new Refs('Bad Project', 'product_analytics'))
  })
})

test.group('analytics:bq-setup (MUL-148)', () => {
  test('prints the plan and SQL without touching BigQuery by default', async ({ assert }) => {
    const lines: string[] = []
    const warehouse = new FakeWarehouse()
    const result = await bqSetup({ config: TEST_CONFIG, apply: false, printSql: true, log: (l) => lines.push(l), warehouse })
    assert.equal(result.applied, 0)
    assert.lengthOf(warehouse.queries, 0)
    const out = lines.join('\n')
    assert.include(out, 'Plan for `test-project-123.product_analytics` in asia-south1')
    assert.include(out, 'CREATE TABLE IF NOT EXISTS `test-project-123.product_analytics.events_raw`')
    assert.include(out, 'Nothing was changed')
  })

  test('prints with an example project when nothing is configured, but refuses to apply', async ({ assert }) => {
    const config = await readWarehouseConfig(() => undefined)
    const lines: string[] = []
    await bqSetup({ config, apply: false, printSql: false, log: (l) => lines.push(l) })
    assert.include(lines.join('\n'), `\`${EXAMPLE_PROJECT}.product_analytics\``)
    await assert.rejects(() => bqSetup({ config, apply: true, printSql: false, log: () => {} }), /GCP_ANALYTICS_PROJECT/)
  })

  test('--apply runs every statement in order with the configured client', async ({ assert }) => {
    const warehouse = new FakeWarehouse()
    const result = await bqSetup({ config: TEST_CONFIG, apply: true, printSql: false, log: () => {}, warehouse })
    assert.equal(result.applied, result.plan.length)
    assert.deepEqual(warehouse.sql, result.plan.map((s) => s.sql))
    assert.match(warehouse.sql[0], /^-- [\s\S]*CREATE SCHEMA IF NOT EXISTS/)
  })

  // The console is Data Editor on the dataset only. BigQuery checks datasets.create on the
  // project even for CREATE SCHEMA IF NOT EXISTS, so with an owner-created dataset the
  // first statement used to fail with Access Denied (found in the first real setup).
  test('an existing dataset is not created again; the tables are', async ({ assert }) => {
    const warehouse = Object.assign(new FakeWarehouse(), { datasetExists: async () => true })
    const lines: string[] = []
    const result = await bqSetup({ config: TEST_CONFIG, apply: true, printSql: false, log: (l) => lines.push(l), warehouse })
    assert.equal(result.applied, result.plan.length - 1)
    assert.notMatch(warehouse.sql.join('\n'), /CREATE SCHEMA/)
    assert.include(lines.join('\n'), 'skipping 1/')
    assert.include(lines.join('\n'), '(already exists)')
  })

  test('a missing dataset is created first', async ({ assert }) => {
    const warehouse = Object.assign(new FakeWarehouse(), { datasetExists: async () => false })
    const result = await bqSetup({ config: TEST_CONFIG, apply: true, printSql: false, log: () => {}, warehouse })
    assert.equal(result.applied, result.plan.length)
    assert.match(warehouse.sql[0], /CREATE SCHEMA IF NOT EXISTS/)
  })

  test('stops at the first failing statement', async ({ assert }) => {
    let calls = 0
    const warehouse = new FakeWarehouse(() => {
      if (++calls === 3) throw new Error('Access Denied')
      return []
    })
    await assert.rejects(() => bqSetup({ config: TEST_CONFIG, apply: true, printSql: false, log: () => {}, warehouse }), /Access Denied/)
    assert.lengthOf(warehouse.queries, 3)
  })
})

test.group('Product analytics configuration', () => {
  const key = JSON.stringify({ client_email: 'analytics-test@example.invalid', private_key: 'not-a-key', project_id: 'x' })

  test('names what is missing, never values', async ({ assert }) => {
    const config = await readWarehouseConfig(() => undefined)
    assert.isFalse(config.connected)
    assert.deepEqual(config.missing, ['GCP_ANALYTICS_PROJECT', 'GCP_ANALYTICS_CREDENTIALS_JSON (or GCP_ANALYTICS_CREDENTIALS_FILE)'])
    assert.equal(config.dataset, 'product_analytics')
    assert.equal(config.location, 'asia-south1')
  })

  test('connects with a project and a key (raw or base64 JSON)', async ({ assert }) => {
    for (const value of [key, Buffer.from(key).toString('base64')]) {
      const env: Record<string, string> = { GCP_ANALYTICS_PROJECT: 'test-project-123', GCP_ANALYTICS_CREDENTIALS_JSON: value }
      const config = await readWarehouseConfig((k) => env[k])
      assert.isTrue(config.connected)
      assert.equal(config.credentials?.client_email, 'analytics-test@example.invalid')
      assert.notProperty(publicStatus(config), 'credentials')
      assert.notInclude(JSON.stringify(publicStatus(config)), 'not-a-key')
    }
  })

  test('a malformed project, dataset or key is a problem, not a crash', async ({ assert }) => {
    const bad = async (env: Record<string, string>) => (await readWarehouseConfig((k) => env[k])).problem
    assert.match((await bad({ GCP_ANALYTICS_PROJECT: 'My Project', GCP_ANALYTICS_CREDENTIALS_JSON: key }))!, /project id/)
    assert.match((await bad({ GCP_ANALYTICS_PROJECT: 'test-project-123', GCP_ANALYTICS_DATASET: 'a-b', GCP_ANALYTICS_CREDENTIALS_JSON: key }))!, /DATASET/)
    assert.match((await bad({ GCP_ANALYTICS_PROJECT: 'test-project-123', GCP_ANALYTICS_CREDENTIALS_JSON: '{nope' }))!, /not valid JSON/)
    assert.match((await bad({ GCP_ANALYTICS_PROJECT: 'test-project-123', GCP_ANALYTICS_CREDENTIALS_JSON: '{"a":1}' }))!, /not a service-account key/)
  })
})
