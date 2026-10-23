import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

const dbConfig = defineConfig({
  connection: 'mysql',
  connections: {
    /*
    | Insights run heavy aggregate reads: point DB_ANALYTICS_HOST at a read replica so they
    | never compete with learners' writes on the primary (falls back to the primary).
    */
    analytics: {
      client: 'mysql2',
      connection: {
        host: env.get('DB_ANALYTICS_HOST') ?? env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_ANALYTICS_USER') ?? env.get('DB_USER'),
        password: env.get('DB_ANALYTICS_PASSWORD') ?? env.get('DB_PASSWORD'),
        database: env.get('DB_DATABASE'),
      },
      pool: { min: 0, max: 4 },
    },
    mysql: {
      client: 'mysql2',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD'),
        database: env.get('DB_DATABASE'),
      },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
        // The database is shared: the monolith owns `adonis_schema`, the tutor API
        // `tutor_api_schema`. The console tracks its own migrations here.
        tableName: 'console_api_schema',
        disableRollbacksInProduction: true,
      },
    },
  },
})

export default dbConfig
