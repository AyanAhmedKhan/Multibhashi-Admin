import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Hardening headers on every API response: JSON only, never framed, never cached
 * (staff data must not linger in shared caches or the back/forward cache).
 */
export default class SecurityHeadersMiddleware {
  async handle({ response }: HttpContext, next: NextFn) {
    response.header('X-Content-Type-Options', 'nosniff')
    response.header('X-Frame-Options', 'DENY')
    response.header('Referrer-Policy', 'no-referrer')
    response.header('Cache-Control', 'no-store')
    response.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    response.header('Cross-Origin-Resource-Policy', 'same-origin')
    if (app.inProduction) {
      response.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    return next()
  }
}
