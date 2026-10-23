import type ConsoleSession from '#models/console_session'
import type ConsoleUser from '#models/console_user'

/** The signed-in staff member behind a request, as every service sees them. */
export interface Actor {
  user: ConsoleUser
  session: ConsoleSession
  roles: { id: number; slug: string; name: string }[]
  permissions: Set<string>
  ip: string
  userAgent: string | null
  requestId: string | null
}

declare module '@adonisjs/core/http' {
  interface HttpContext {
    actor: Actor
  }
}
