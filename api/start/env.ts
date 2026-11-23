/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
*/

import { Env } from '@adonisjs/core/env'

const env = await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  APP_NAME: Env.schema.string.optional(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),

  /*
  | The console's public origin(s), comma separated (e.g. https://admin.multibhashi.com).
  | Unsafe requests whose Origin header is not listed are refused (CSRF defence), and
  | invite links are built on the first one.
  */
  CONSOLE_ORIGINS: Env.schema.string(),

  /*
  |----------------------------------------------------------
  | Database (shared with the monolith and the tutor API)
  |----------------------------------------------------------
  | Give the console its own MySQL user: SELECT on the platform tables, write only on
  | the tables it changes, and INSERT/SELECT only on console_audit_logs.
  */
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),
  // Optional read replica (and a read-only user) for the Insights pages.
  DB_ANALYTICS_HOST: Env.schema.string.optional(),
  DB_ANALYTICS_USER: Env.schema.string.optional(),
  DB_ANALYTICS_PASSWORD: Env.schema.string.optional(),

  /*
  | LiveKit (same project as the tutor): lists live classes and ends one on request.
  */
  LIVEKIT_API_KEY: Env.schema.string(),
  LIVEKIT_API_SECRET: Env.schema.string(),
  LIVEKIT_URL: Env.schema.string(),

  /*
  | Tutor API base URL, for the health page (GET /health/ready).
  */
  TUTOR_API_URL: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Email (sign-in codes, invites). Gmail: smtp.gmail.com, 465, secure, the Gmail address
  | as user and a 16-character App Password (Google account → Security → App passwords).
  | Without it, development writes emails to api/tmp/mail; production falls back to
  | authenticator-app codes.
  |----------------------------------------------------------
  */
  SMTP_HOST: Env.schema.string.optional(),
  SMTP_PORT: Env.schema.number.optional(),
  SMTP_SECURE: Env.schema.boolean.optional(),
  SMTP_USER: Env.schema.string.optional(),
  SMTP_PASSWORD: Env.schema.string.optional(),
  MAIL_FROM: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | The providers' own usage and billing (docs/QUIZ_OBSERVABILITY.md §3): the WHOLE OpenAI
  | organisation and GCP billing account are synced; the quiz ids below only attribute part of
  | it to the quizzes when reading. All optional: without them the Cost page says "not
  | connected" and the quiz figures are estimates.
  | Production values live only in deploy/.env.production on the server.
  |----------------------------------------------------------
  */
  // An OpenAI organisation Admin key (Usage + Costs APIs), not a normal API key.
  OPENAI_ADMIN_KEY: Env.schema.string.optional(),
  // Attribution: the quiz backend's OpenAI project id and/or API key ids (comma separated).
  OPENAI_QUIZ_PROJECT_ID: Env.schema.string.optional(),
  OPENAI_QUIZ_API_KEY_IDS: Env.schema.string.optional(),
  // Service account (BigQuery Data Viewer on the export dataset + BigQuery Job User): the JSON
  // itself (raw or base64) or a path to the key file.
  GCP_BILLING_CREDENTIALS_JSON: Env.schema.string.optional(),
  GCP_BILLING_CREDENTIALS_FILE: Env.schema.string.optional(),
  // project.dataset.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX
  GCP_BILLING_EXPORT_TABLE: Env.schema.string.optional(),
  // Attribution: the project quiz speech-to-text is billed to (multibhashi-android-app).
  GCP_SPEECH_PROJECT_ID: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Product analytics (docs/PRODUCT_ANALYTICS.md, MUL-125): the BigQuery dataset the app's
  | collector writes events into (asia-south1). The console exports the business facts, builds
  | the nightly models and reads them on Insights. All optional: without them the product
  | analytics tabs say "not connected yet" and the analytics:* commands do nothing.
  |----------------------------------------------------------
  */
  // The GCP project that holds the dataset and runs the jobs.
  GCP_ANALYTICS_PROJECT: Env.schema.string.optional(),
  // Default product_analytics.
  GCP_ANALYTICS_DATASET: Env.schema.string.optional(),
  // Service account (BigQuery Data Editor on the dataset + BigQuery Job User on the project):
  // the JSON itself (raw or base64) or a path to the key file.
  GCP_ANALYTICS_CREDENTIALS_JSON: Env.schema.string.optional(),
  GCP_ANALYTICS_CREDENTIALS_FILE: Env.schema.string.optional(),
})

if (env.get('NODE_ENV') === 'production') {
  for (const origin of env.get('CONSOLE_ORIGINS').split(',')) {
    if (!origin.trim().startsWith('https://')) {
      throw new Error('CONSOLE_ORIGINS must be https:// origins in production')
    }
  }
}

export default env
