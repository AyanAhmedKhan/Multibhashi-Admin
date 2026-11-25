import env from '#start/env'
import { readServiceAccount, type GoogleCredentials } from '#helpers/gcp_credentials'

/**
 * Product analytics warehouse (MUL-148, design/IMPLEMENTATION-CONTRACTS.md §5.4): the BigQuery
 * dataset `product_analytics` in asia-south1. The collector writes events into it; the console
 * exports the business facts, builds the models and reads them for Insights.
 *
 * Settings (names only here; values live in the server's env file):
 * - GCP_ANALYTICS_PROJECT: the GCP project that holds the dataset and runs the jobs;
 * - GCP_ANALYTICS_DATASET: optional, default `product_analytics`;
 * - GCP_ANALYTICS_CREDENTIALS_JSON or GCP_ANALYTICS_CREDENTIALS_FILE: the console's service
 *   account (BigQuery Data Editor on the dataset + BigQuery Job User on the project).
 * Without them every product-analytics page says "not connected yet": a status, never an error.
 */

export const LOCATION = 'asia-south1'
export const DEFAULT_DATASET = 'product_analytics'

/** GCP project ids: 6–30 chars, lower-case letters, digits and hyphens, starting with a letter. */
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
/** BigQuery dataset ids: letters, digits and underscores. */
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/

export const validProject = (v: string) => PROJECT.test(v)
export const validDataset = (v: string) => DATASET.test(v)

export interface WarehouseConfig {
  connected: boolean
  /** Env names that are not set (names only). */
  missing: string[]
  problem?: string
  project?: string
  dataset: string
  location: string
  credentials?: GoogleCredentials
}

type Get = (key: string) => string | undefined

const fromEnv: Get = (k) => env.get(k as never) as string | undefined

export async function readWarehouseConfig(get: Get = fromEnv): Promise<WarehouseConfig> {
  const missing: string[] = []
  let problem: string | undefined
  const project = get('GCP_ANALYTICS_PROJECT')?.trim()
  const dataset = get('GCP_ANALYTICS_DATASET')?.trim() || DEFAULT_DATASET
  if (!project) missing.push('GCP_ANALYTICS_PROJECT')
  else if (!validProject(project)) problem = 'GCP_ANALYTICS_PROJECT is not a GCP project id (lower-case letters, digits, hyphens)'
  if (!validDataset(dataset)) problem = problem ?? 'GCP_ANALYTICS_DATASET may only hold letters, digits and underscores'
  const account = await readServiceAccount('GCP_ANALYTICS_CREDENTIALS', get)
  missing.push(...account.missing)
  problem = problem ?? account.problem
  return {
    connected: !missing.length && !problem,
    missing,
    problem,
    project,
    dataset,
    location: LOCATION,
    credentials: account.credentials,
  }
}

/** What a page may show about the connection: never the credentials. */
export function publicStatus(config: WarehouseConfig) {
  return { connected: config.connected, missing: config.missing, problem: config.problem ?? null, location: config.location }
}
