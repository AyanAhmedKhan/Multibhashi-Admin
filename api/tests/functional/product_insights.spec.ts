import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import encryption from '@adonisjs/core/services/encryption'
import ConsoleUser from '#models/console_user'
import rbacService from '#services/rbac_service'
import consoleConfig from '#config/console'
import settingsService from '#services/settings_service'
import { readWarehouseConfig } from '#services/product_analytics/config'
import { hotp, timeStep } from '#helpers/totp'
import { randomToken, sha256 } from '#helpers/tokens'
import type { ApiClient } from '@japa/api-client'

/**
 * Insights → product analytics over HTTP (MUL-152), against the local database. BigQuery is
 * never contacted: without GCP_ANALYTICS_* the pages answer "not connected". Uses its own
 * @test.local staff only.
 */

const ORIGIN = consoleConfig.origins[0]
const PASSWORD = 'correct horse battery staple'
const EMAILS = ['pa-owner@test.local', 'pa-support@test.local']

async function cleanup() {
  const ids = (await db.from('console_users').whereIn('email', EMAILS).select('id')).map((s) => s.id)
  if (!ids.length) return
  await db.from('console_sessions').whereIn('user_id', ids).delete()
  await db.from('console_user_roles').whereIn('user_id', ids).delete()
  await db.from('console_users').whereIn('id', ids).delete()
}

async function staff(client: ApiClient, email: string, roleSlug: string) {
  const token = randomToken()
  const user = await ConsoleUser.create({
    email,
    name: email.split('@')[0],
    status: 'invited',
    setupTokenHash: sha256(token),
    setupExpiresAt: DateTime.now().plus({ hours: 1 }),
    failedLogins: 0,
  })
  const role = await db.from('console_roles').where('slug', roleSlug).first()
  await db.table('console_user_roles').insert({ user_id: user.id, role_id: role.id, created_at: new Date() })
  const info = await client.get(`/api/auth/setup/${token}`)
  ;(await client.post(`/api/auth/setup/${token}`).header('origin', ORIGIN).json({ password: PASSWORD, code: hotp(info.body().secret, timeStep()) })).assertStatus(200)
  const login = await client.post('/api/auth/login').header('origin', ORIGIN).json({ email, password: PASSWORD })
  login.assertStatus(200)
  await db.from('console_users').where('id', user.id).update({ mfa_last_step: null })
  const fresh = await ConsoleUser.findOrFail(user.id)
  const mfa = await client
    .post('/api/auth/mfa')
    .header('origin', ORIGIN)
    .header('cookie', String(login.headers()['set-cookie']).split(';')[0])
    .header('x-csrf-token', login.body().csrfToken)
    .json({ code: hotp(encryption.decrypt<string>(fresh.mfaSecret!)!, timeStep()) })
  mfa.assertStatus(200)
  return String(mfa.headers()['set-cookie']).split(';')[0]
}

test.group('Insights: product analytics endpoints (MUL-152)', (group) => {
  let previousMfa: unknown = null
  group.setup(async () => {
    previousMfa = (await db.from('console_settings').where('key', 'mfa_method').first())?.value ?? null
    await db.from('console_settings').where('key', 'mfa_method').delete()
    await db.table('console_settings').insert({ key: 'mfa_method', value: JSON.stringify('totp'), updated_at: new Date() })
    settingsService.clearCache()
    await cleanup()
    await rbacService.syncSystemRoles()
  })
  group.teardown(async () => {
    await cleanup()
    await db.from('console_settings').where('key', 'mfa_method').delete()
    if (previousMfa !== null) {
      await db.table('console_settings').insert({ key: 'mfa_method', value: typeof previousMfa === 'string' ? previousMfa : JSON.stringify(previousMfa), updated_at: new Date() })
    }
    settingsService.clearCache()
  })

  test('behind analytics.read; "not connected" without settings; input validated', async ({ client, assert }) => {
    const owner = await staff(client, EMAILS[0], 'super_admin')
    const support = await staff(client, EMAILS[1], 'support_agent')
    const get = (cookie: string, url: string) => client.get(url).header('origin', ORIGIN).header('cookie', cookie)
    const pages = ['status', 'overview', 'screens', 'features', 'funnels', 'dropoffs', 'retention', 'health']

    for (const page of pages) (await get(support, `/api/insights/product/${page}?days=7`)).assertStatus(403)

    if (!(await readWarehouseConfig()).connected) {
      for (const page of pages) {
        const res = await get(owner, `/api/insights/product/${page}?days=7`)
        res.assertStatus(200)
        assert.isFalse(res.body().connected, page)
        assert.include(res.body().missing.join(' '), 'GCP_ANALYTICS_PROJECT', page)
        assert.notInclude(JSON.stringify(res.body()), 'private_key')
      }
    }
    ;(await get(owner, '/api/insights/product/overview?days=5')).assertStatus(422)
    ;(await get(owner, '/api/insights/product/funnels?funnel=nope')).assertStatus(422)
    ;(await get(owner, '/api/insights/product/funnels?breakdown=phone')).assertStatus(422)
    // The existing Insights tabs are unchanged.
    ;(await get(owner, '/api/insights/users?days=7')).assertStatus(200)
  }).timeout(60_000)
})
