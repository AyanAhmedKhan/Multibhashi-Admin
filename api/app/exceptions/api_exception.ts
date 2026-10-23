import { Exception } from '@adonisjs/core/exceptions'

/**
 * Domain error carrying an HTTP status, a machine-readable code the UI branches on
 * (e.g. STEP_UP_REQUIRED, APPROVAL_REQUIRED) and a message a staff member can read.
 */
export default class ApiException extends Exception {
  constructor(status: number, message: string, code = 'REQUEST') {
    super(message, { status, code })
  }
}
