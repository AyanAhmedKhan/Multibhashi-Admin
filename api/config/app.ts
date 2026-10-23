import env from '#start/env'
import proxyAddr from 'proxy-addr'
import app from '@adonisjs/core/services/app'
import { Secret } from '@adonisjs/core/helpers'
import { defineConfig } from '@adonisjs/core/http'

/**
 * Signs the session cookie and encrypts MFA secrets at rest. Rotating it signs every
 * staff member out and requires MFA re-enrolment, so keep it in the secret store.
 */
export const appKey = new Secret(env.get('APP_KEY'))

export const http = defineConfig({
  generateRequestId: true,
  allowMethodSpoofing: false,
  // nginx in front of the API: trust it so request.ip() is the staff member's IP.
  trustProxy: proxyAddr.compile(['loopback', 'uniquelocal']),
  useAsyncLocalStorage: false,
  cookie: {
    domain: '',
    path: '/',
    maxAge: '12h',
    httpOnly: true,
    secure: app.inProduction,
    sameSite: 'strict',
  },
})
