import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import consoleConfig from '#config/console'

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * CSRF, first layer (with SameSite=Strict cookies and the per-session token checked in
 * the auth middleware): a state-changing request must come from the console's own
 * origin and carry JSON (a cross-site HTML form can't send application/json).
 */
export default class OriginGuardMiddleware {
  async handle({ request, response }: HttpContext, next: NextFn) {
    if (!UNSAFE.has(request.method())) return next()
    const origin = request.header('origin')
    const referer = request.header('referer')
    let source = origin
    if (!source && referer) {
      try {
        source = new URL(referer).origin
      } catch {
        source = undefined
      }
    }
    if (!source || !consoleConfig.origins.includes(source)) {
      return response.status(403).json({ error: { code: 'BAD_ORIGIN', message: 'Request refused (origin).' } })
    }
    if (!request.is(['json'])) {
      return response.status(415).json({ error: { code: 'JSON_ONLY', message: 'Send JSON.' } })
    }
    return next()
  }
}
