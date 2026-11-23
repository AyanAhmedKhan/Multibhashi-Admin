import { readFile } from 'node:fs/promises'

/**
 * A Google service-account key, as both BigQuery integrations take it from the environment:
 * the key JSON itself (raw or base64) in `<PREFIX>_JSON`, or a path to the key file in
 * `<PREFIX>_FILE`. Only the three fields the client needs are kept; the key is never logged
 * or returned to a page.
 */
export interface GoogleCredentials {
  project_id?: string
  client_email?: string
  private_key?: string
}

export function parseCredentials(raw: string): GoogleCredentials {
  const attempt = (text: string) => JSON.parse(text) as GoogleCredentials
  try {
    return attempt(raw)
  } catch {
    return attempt(Buffer.from(raw, 'base64').toString('utf8'))
  }
}

export interface ServiceAccountResult {
  credentials?: GoogleCredentials
  /** Env names that are not set (names only, never values). */
  missing: string[]
  problem?: string
}

/** Reads `<prefix>_JSON` or `<prefix>_FILE` and says what is missing or wrong. */
export async function readServiceAccount(prefix: string, get: (key: string) => string | undefined): Promise<ServiceAccountResult> {
  const jsonName = `${prefix}_JSON`
  const fileName = `${prefix}_FILE`
  const json = get(jsonName)
  const file = get(fileName)
  if (!json && !file) return { missing: [`${jsonName} (or ${fileName})`] }
  try {
    const credentials = parseCredentials(json ?? (await readFile(file!, 'utf8')))
    if (!credentials.client_email || !credentials.private_key) {
      return { missing: [], problem: 'The GCP credentials are not a service-account key (client_email / private_key missing)' }
    }
    return { credentials, missing: [] }
  } catch {
    return {
      missing: [],
      problem: json ? `${jsonName} is not valid JSON (or base64 JSON)` : `${fileName} could not be read as a JSON key file`,
    }
  }
}
