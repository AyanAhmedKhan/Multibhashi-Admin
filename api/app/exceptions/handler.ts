import app from '@adonisjs/core/services/app'
import { HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import { errors as vineErrors } from '@vinejs/vine'

export default class HttpExceptionHandler extends ExceptionHandler {
  protected debug = !app.inProduction

  /**
   * Every error leaves as `{ error: { code, message, fields? } }`. Unexpected errors
   * (5xx) never leak SQL, hosts or stacks to the browser in production; they are still
   * reported (logs) by report() below.
   */
  async handle(error: unknown, ctx: HttpContext) {
    if (error instanceof vineErrors.E_VALIDATION_ERROR) {
      const fields: Record<string, string> = {}
      for (const message of error.messages as { field: string; message: string }[]) {
        fields[message.field] ??= message.message
      }
      return ctx.response.status(422).json({
        error: { code: 'VALIDATION', message: 'Please check the highlighted fields.', fields },
      })
    }

    const status = Number((error as { status?: number })?.status) || 500
    const code = (error as { code?: string })?.code
    if (status >= 500) {
      if (app.inProduction) {
        return ctx.response
          .status(status)
          .json({ error: { code: 'SERVER', message: 'Something went wrong. Please try again.' } })
      }
      return super.handle(error, ctx)
    }
    return ctx.response.status(status).json({
      error: {
        code: code && !code.startsWith('E_') ? code : status === 404 ? 'NOT_FOUND' : 'REQUEST',
        message: (error as Error)?.message || 'Request failed',
      },
    })
  }

  async report(error: unknown, ctx: HttpContext) {
    return super.report(error, ctx)
  }
}
