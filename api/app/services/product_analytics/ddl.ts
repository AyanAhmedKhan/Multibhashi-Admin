import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bigQueryWarehouse, type Warehouse } from '#services/product_analytics/warehouse'
import { DEFAULT_DATASET, validDataset, validProject, type WarehouseConfig } from '#services/product_analytics/config'

/**
 * The warehouse's DDL (MUL-148): plain SQL files in api/analytics/bigquery, applied in file
 * order by `analytics:bq-setup --apply`. Every statement is idempotent (CREATE … IF NOT EXISTS,
 * ALTER … SET OPTIONS), so the setup can be re-run after each deploy. The files use three
 * placeholders, filled from the configuration and validated first: {{project}}, {{dataset}},
 * {{location}}. adonisrc.ts copies the files into the build (metaFiles).
 */

export const DDL_DIR = fileURLToPath(new URL('../../../analytics/bigquery/', import.meta.url))

/** Every table the setup creates, by role. */
export const EVENT_TABLES = ['events_raw', 'events_dev'] as const
export const FACT_TABLES = [
  'fact_users',
  'fact_bookings',
  'fact_payments',
  'fact_class_attendance',
  'fact_quiz_attempts',
  'fact_tutor_sessions',
  'identities',
] as const
export const MODEL_TABLES = [
  'm_identity_links',
  'm_user_firsts',
  'm_sessions',
  'm_screen_daily',
  'm_feature_daily',
  'm_funnel_steps',
  'm_retention_weekly',
  'm_health_daily',
] as const

export interface DdlVars {
  project: string
  dataset: string
  location: string
}

export interface DdlFile {
  file: string
  sql: string
}

export interface DdlStatement {
  file: string
  kind: 'dataset' | 'table' | 'alter' | 'other'
  object: string
  sql: string
}

const VARS = /\{\{\s*([a-z_]+)\s*\}\}/g

export function renderSql(template: string, vars: DdlVars) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(vars.project)) throw new Error('Invalid GCP project id')
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/.test(vars.dataset)) throw new Error('Invalid BigQuery dataset id')
  if (!/^[a-z]+(-[a-z]+)?[0-9]*$/.test(vars.location)) throw new Error('Invalid BigQuery location')
  return template.replace(VARS, (_, name: string) => {
    if (!(name in vars)) throw new Error(`Unknown placeholder {{${name}}}`)
    return vars[name as keyof DdlVars]
  })
}

/**
 * Statements of a file: a statement ends on a code line ending with ';'. Comment lines
 * (starting with --) stay with the statement they precede; a file's trailing comments drop.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let hasCode = false
  for (const line of sql.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed && !hasCode) {
      current = []
      continue
    }
    current.push(line)
    if (trimmed.startsWith('--')) continue
    if (trimmed) hasCode = true
    if (trimmed.endsWith(';')) {
      out.push(current.join('\n').trim())
      current = []
      hasCode = false
    }
  }
  if (hasCode) out.push(current.join('\n').trim())
  return out
}

const codeOf = (statement: string) =>
  statement
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')

export function describeStatement(statement: string): Pick<DdlStatement, 'kind' | 'object'> {
  const code = codeOf(statement)
  const schema = code.match(/CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/i)
  if (schema) return { kind: 'dataset', object: schema[1] }
  const table = code.match(/CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/i)
  if (table) return { kind: 'table', object: table[1] }
  const alter = code.match(/ALTER\s+TABLE\s+`([^`]+)`/i)
  if (alter) return { kind: 'alter', object: alter[1] }
  return { kind: 'other', object: '' }
}

export async function loadDdlFiles(dir = DDL_DIR): Promise<DdlFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  return Promise.all(names.map(async (file) => ({ file, sql: await readFile(join(dir, file), 'utf8') })))
}

export function setupPlan(files: DdlFile[], vars: DdlVars): DdlStatement[] {
  return files.flatMap(({ file, sql }) =>
    splitStatements(renderSql(sql, vars)).map((statement) => ({ file, ...describeStatement(statement), sql: statement }))
  )
}

/**
 * Runs the plan in order and stops at the first failure (later tables may depend on it).
 * The CREATE SCHEMA statement is skipped when the dataset already
 * exists: even with IF NOT EXISTS, BigQuery checks bigquery.datasets.create on the PROJECT,
 * which the console account deliberately doesn't have (it is Data Editor on the dataset
 * only). So an owner can create the dataset once, and the console sets up the rest.
 */
export async function applyPlan(
  plan: DdlStatement[],
  warehouse: Warehouse,
  onStep?: (s: DdlStatement, skipped?: string) => void
) {
  let applied = 0
  for (const statement of plan) {
    if (statement.kind === 'dataset' && warehouse.datasetExists && (await warehouse.datasetExists())) {
      onStep?.(statement, 'already exists')
      continue
    }
    onStep?.(statement)
    await warehouse.query(statement.sql)
    applied++
  }
  return applied
}

/** Placeholder project for printing the DDL before GCP_ANALYTICS_PROJECT is set. */
export const EXAMPLE_PROJECT = 'your-gcp-project'

export interface SetupOptions {
  config: WarehouseConfig
  apply: boolean
  /** Print each statement's SQL, not only the plan. */
  printSql: boolean
  log: (line: string) => void
  files?: DdlFile[]
  warehouse?: Warehouse
}

/**
 * `analytics:bq-setup`: prints the plan (and the SQL) by default; with apply, runs it with the
 * configured credentials. Applying needs a complete configuration; printing doesn't (an example
 * project id stands in).
 */
export async function bqSetup(opts: SetupOptions): Promise<{ plan: DdlStatement[]; applied: number }> {
  const { config, log } = opts
  if (opts.apply && !config.connected) {
    throw new Error(config.problem ?? `Product analytics is not configured: set ${config.missing.join(', ')}`)
  }
  const usable = !!config.project && validProject(config.project)
  const dataset = validDataset(config.dataset) ? config.dataset : DEFAULT_DATASET
  const vars: DdlVars = { project: usable ? config.project! : EXAMPLE_PROJECT, dataset, location: config.location }
  if (!usable) log(`GCP_ANALYTICS_PROJECT is not set (or not a project id): the SQL below uses "${EXAMPLE_PROJECT}".`)
  const plan = setupPlan(opts.files ?? (await loadDdlFiles()), vars)
  log(`Plan for \`${vars.project}.${vars.dataset}\` in ${vars.location} (${plan.length} statements, all idempotent):`)
  plan.forEach((s, i) => log(`  ${String(i + 1).padStart(2)}. ${s.kind.padEnd(7)} ${s.object.split('.').pop()}  (${s.file})`))
  if (opts.printSql) {
    for (const s of plan) log(`\n-- ${s.file}\n${s.sql}`)
  }
  if (!opts.apply) {
    log('\nNothing was changed. Run with --apply to create or update these objects in BigQuery.')
    return { plan, applied: 0 }
  }
  const warehouse = opts.warehouse ?? (await bigQueryWarehouse(config))
  let step = 0
  const applied = await applyPlan(plan, warehouse, (s, skipped) => {
    step++
    log(`${skipped ? 'skipping' : 'applying'} ${step}/${plan.length}: ${s.kind} ${s.object.split('.').pop()}${skipped ? ` (${skipped})` : ''}`)
  })
  return { plan, applied }
}

/** Column names and types of a CREATE TABLE statement (top-level columns only). */
export function columnsOf(statement: string): { name: string; type: string }[] {
  const code = codeOf(statement)
  const start = code.indexOf('(')
  if (start < 0) return []
  let depth = 0
  let end = -1
  for (let i = start; i < code.length; i++) {
    if (code[i] === '(' || code[i] === '<') depth++
    else if (code[i] === ')' || code[i] === '>') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = code.slice(start + 1, end)
  const columns: { name: string; type: string }[] = []
  let part = ''
  depth = 0
  for (const ch of body + ',') {
    if (ch === '<' || ch === '(') depth++
    if (ch === '>' || ch === ')') depth--
    if (ch === ',' && depth === 0) {
      const m = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/s)
      if (m) columns.push({ name: m[1], type: m[2].replace(/\s+NOT\s+NULL$/i, '').replace(/\s+/g, ' ').trim() })
      part = ''
    } else part += ch
  }
  return columns
}
