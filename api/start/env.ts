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
})

if (env.get('NODE_ENV') === 'production') {
  for (const origin of env.get('CONSOLE_ORIGINS').split(',')) {
    if (!origin.trim().startsWith('https://')) {
      throw new Error('CONSOLE_ORIGINS must be https:// origins in production')
    }
  }
}

export default env
