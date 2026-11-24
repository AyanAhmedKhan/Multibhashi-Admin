import type { WarehouseConfig } from '#services/product_analytics/config'

/**
 * The BigQuery calls product analytics makes, behind an interface so tests run on a fake and
 * never reach Google. `query` runs one statement or a multi-statement script (named
 * parameters, standard SQL, in the dataset's location); `load` runs a load job from a local
 * newline-delimited JSON file into an existing table.
 */

export type QueryParams = Record<string, unknown>
/** BigQuery parameter types, needed only for empty arrays or NULLs (e.g. { ids: ['STRING'] }). */
export type QueryTypes = Record<string, string | string[]>
export type WriteDisposition = 'WRITE_TRUNCATE' | 'WRITE_APPEND'

export interface Warehouse {
  query(sql: string, params?: QueryParams, types?: QueryTypes): Promise<Record<string, unknown>[]>
  load(table: string, ndjsonFile: string, write: WriteDisposition): Promise<void>
  /** A DML statement (DELETE …): how many rows it changed, when BigQuery says. */
  execute(sql: string, params?: QueryParams, types?: QueryTypes): Promise<{ affectedRows: number | null }>
}

const NAME = /^[a-z_][a-z0-9_]{0,127}$/

/** Fully-qualified, back-quoted names for SQL. Every part is validated: they go into SQL text. */
export class Refs {
  constructor(
    readonly project: string,
    readonly dataset: string
  ) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error('Invalid GCP project id')
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/.test(dataset)) throw new Error('Invalid BigQuery dataset id')
  }

  /** `project.dataset.name` */
  t(name: string) {
    if (!NAME.test(name)) throw new Error(`Invalid table name: ${name}`)
    return `\`${this.project}.${this.dataset}.${name}\``
  }

  get datasetRef() {
    return `\`${this.project}.${this.dataset}\``
  }
}

export function refsOf(config: WarehouseConfig) {
  if (!config.project) throw new Error('GCP_ANALYTICS_PROJECT is not set')
  return new Refs(config.project, config.dataset)
}

/** BigQuery returns DATE/TIMESTAMP/NUMERIC as `{ value }` wrappers: unwrap to plain values. */
export function plain(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && 'value' in (v as object)) {
    return (v as { value: unknown }).value
  }
  return v
}

export const str = (v: unknown): string | null => {
  const p = plain(v)
  return p === null || p === undefined ? null : String(p)
}

export const num = (v: unknown): number => {
  const p = Number(plain(v) ?? 0)
  return Number.isFinite(p) ? p : 0
}

export const numOrNull = (v: unknown): number | null => {
  const p = plain(v)
  if (p === null || p === undefined) return null
  const n = Number(p)
  return Number.isFinite(n) ? n : null
}

/** A short message from a BigQuery error, without anything that could be a credential. */
export function bqMessage(error: unknown) {
  const e = error as { message?: string; errors?: { message?: string }[] }
  return String(e?.errors?.[0]?.message ?? e?.message ?? error).slice(0, 300)
}

/** A missing table or dataset: the setup or the first model run hasn't happened yet. */
export function isNotFound(error: unknown) {
  const e = error as { code?: number; message?: string }
  return e?.code === 404 || /not found: (table|dataset)/i.test(String(e?.message ?? ''))
}

/** The real client, loaded only when product analytics is configured. */
export async function bigQueryWarehouse(config: WarehouseConfig): Promise<Warehouse> {
  if (!config.connected || !config.project || !config.credentials) throw new Error('Product analytics BigQuery is not configured')
  const { BigQuery } = await import('@google-cloud/bigquery')
  const bq = new BigQuery({
    projectId: config.project,
    location: config.location,
    credentials: { client_email: config.credentials.client_email, private_key: config.credentials.private_key },
  })
  const optionsOf = (sql: string, params?: QueryParams, types?: QueryTypes) => {
    const options: Record<string, unknown> = { query: sql, location: config.location, useLegacySql: false }
    if (params && Object.keys(params).length) options.params = params
    if (types && Object.keys(types).length) options.types = types
    return options as never
  }
  return {
    async query(sql, params, types) {
      const [rows] = await bq.query(optionsOf(sql, params, types))
      return rows as Record<string, unknown>[]
    },
    async execute(sql, params, types) {
      const [job] = await bq.createQueryJob(optionsOf(sql, params, types))
      await job.getQueryResults()
      const [meta] = await job.getMetadata()
      const affected = (meta as { statistics?: { query?: { numDmlAffectedRows?: string } } })?.statistics?.query?.numDmlAffectedRows
      return { affectedRows: affected === undefined ? null : Number(affected) }
    },
    async load(table, ndjsonFile, write) {
      if (!NAME.test(table)) throw new Error(`Invalid table name: ${table}`)
      const [job] = await bq.dataset(config.dataset).table(table).load(ndjsonFile, {
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: write,
        createDisposition: 'CREATE_NEVER',
        location: config.location,
      } as never)
      const errors = (job as { status?: { errors?: { message?: string }[] } }).status?.errors
      if (errors?.length) throw new Error(`BigQuery load into ${table}: ${String(errors[0].message).slice(0, 300)}`)
    },
  }
}

export interface OpenWarehouse {
  config: WarehouseConfig
  refs: Refs | null
  client: Warehouse | null
}

/** The configuration and, when it is complete, the real client and table names. */
export async function openWarehouse(config?: WarehouseConfig): Promise<OpenWarehouse> {
  const { readWarehouseConfig } = await import('#services/product_analytics/config')
  const cfg = config ?? (await readWarehouseConfig())
  if (!cfg.connected) return { config: cfg, refs: null, client: null }
  return { config: cfg, refs: refsOf(cfg), client: await bigQueryWarehouse(cfg) }
}
