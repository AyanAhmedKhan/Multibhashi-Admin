import { readFile } from 'node:fs/promises'
import type { QueryParams, QueryTypes, Warehouse, WriteDisposition } from '#services/product_analytics/warehouse'
import type { WarehouseConfig } from '#services/product_analytics/config'

/**
 * A BigQuery stand-in for unit tests: records every query and load (with the NDJSON rows it
 * was given) and answers queries with whatever the test's responder returns. Nothing reaches
 * Google.
 */
export class FakeWarehouse implements Warehouse {
  queries: { sql: string; params?: QueryParams; types?: QueryTypes }[] = []
  loads: { table: string; write: WriteDisposition; rows: Record<string, unknown>[] }[] = []

  constructor(private respond: (sql: string, params?: QueryParams) => Record<string, unknown>[] | Promise<Record<string, unknown>[]> = () => []) {}

  async query(sql: string, params?: QueryParams, types?: QueryTypes) {
    this.queries.push({ sql, params, types })
    return this.respond(sql, params)
  }

  async load(table: string, ndjsonFile: string, write: WriteDisposition) {
    const text = await readFile(ndjsonFile, 'utf8')
    this.loads.push({ table, write, rows: text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) })
  }

  /** The SQL of every query, in order. */
  get sql() {
    return this.queries.map((q) => q.sql)
  }
}

/** A complete configuration for tests (fake ids, no real key). */
export const TEST_CONFIG: WarehouseConfig = {
  connected: true,
  missing: [],
  project: 'test-project-123',
  dataset: 'product_analytics',
  location: 'asia-south1',
  credentials: { client_email: 'analytics-test@example.invalid', private_key: 'not-a-key' },
}
