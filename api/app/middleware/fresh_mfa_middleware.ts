import { DateTime } from 'luxon'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import settingsService from '#services/settings_service'

/**
 * Step-up for self-service actions that need no permission but are still sensitive
 * (new recovery codes). Permission-gated routes get this from CanMiddleware.
 */
export default class FreshMfaMiddleware {
  async handle({ actor, response }: HttpContext, next: NextFn) {
    const { step_up_minutes: minutes } = await settingsService.all()
    if (!actor.session.mfaAt || actor.session.mfaAt.plus({ minutes }) <= DateTime.now()) {
      return response.status(403).json({
        error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you: enter a code from your authenticator app.' },
      })
    }
    return next()
  }
}
