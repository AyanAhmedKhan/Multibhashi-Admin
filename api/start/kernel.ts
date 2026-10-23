/*
|--------------------------------------------------------------------------
| HTTP kernel file
|--------------------------------------------------------------------------
*/

import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

server.errorHandler(() => import('#exceptions/handler'))

/**
 * Runs on every request, even unmatched ones. No CORS middleware on purpose: the web
 * app is same-origin, so cross-origin browser calls are simply refused by the browser.
 */
server.use([
  () => import('#middleware/container_bindings_middleware'),
  () => import('#middleware/force_json_response_middleware'),
  () => import('#middleware/security_headers_middleware'),
])

router.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
  () => import('#middleware/origin_guard_middleware'),
])

export const middleware = router.named({
  auth: () => import('#middleware/auth_middleware'),
  can: () => import('#middleware/can_middleware'),
  freshMfa: () => import('#middleware/fresh_mfa_middleware'),
})
