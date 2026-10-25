import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import encryption from '@adonisjs/core/services/encryption'
import ConsoleUser from '#models/console_user'
import rbacService from '#services/rbac_service'
import consoleConfig from '#config/console'
import { hotp, timeStep } from '#helpers/totp'
import { randomToken, sha256 } from '#helpers/tokens'
import settingsService from '#services/settings_service'
import { readdir, readFile } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'
import type { ApiClient, ApiRequest } from '@japa/api-client'

/**
 * End-to-end through HTTP against the local database. Uses its own learner (2001) and
 * @test.local staff only — never the shared test learners 1001/1002.
 */

const ORIGIN = consoleConfig.origins[0]
const LEARNER = 2001
const PASSWORD = 'correct horse battery staple'

interface Session {
  cookie: string
  csrf: string
  userId: number
}

async function cleanup() {
  const staff = await db.from('console_users').where('email', 'like', '%@test.local').select('id')
  const ids = staff.map((s) => s.id)
  if (ids.length) {
    await db.from('console_sessions').whereIn('user_id', ids).delete()
    await db.from('console_user_roles').whereIn('user_id', ids).delete()
    await db.from('console_approval_requests').whereIn('requested_by', ids).delete()
    await db.from('console_users').whereIn('id', ids).delete()
  }
  const chats = await db.from('ai_tutor_chats').where('user_id', LEARNER).select('id')
  await db.from('console_ai_pro_grants').where('user_id', LEARNER).delete()
  await db.from('course_lesson_package_bookings').where('user_id', LEARNER).delete()
  await db.from('course_lesson_subscriptions').where('user_id', LEARNER).delete()
  await db.from('quiz_questions').whereIn('quiz_id', [910_001, 910_002, 910_003]).delete()
  await db.from('course_lessons').where('course_id', 9101).delete()
  await db.from('course_lesson_packages').where('course_id', 9101).delete()
  await db.from('courses').where('id', 9101).delete()
  await db.from('direct_leads').where('user_id', LEARNER).delete()
  await db.from('ai_tutor_time_logs').where('user_id', LEARNER).delete()
  await db.from('ai_tutor_session_summaries').where('user_id', LEARNER).delete()
  await db.from('ai_tutor_learner_memories').where('user_id', LEARNER).delete()
  if (chats.length) await db.from('ai_tutor_chats').where('user_id', LEARNER).delete()
  await db.from('users').where('id', LEARNER).delete()
}

/** A code the server hasn't accepted yet (tests sign in faster than the 30 s TOTP step). */
async function freshCode(userId: number) {
  await db.from('console_users').where('id', userId).update({ mfa_last_step: null })
  const user = await ConsoleUser.findOrFail(userId)
  return hotp(encryption.decrypt<string>(user.mfaSecret!)!, timeStep())
}

async function invitedUser(email: string, roleSlug: string) {
  const token = randomToken()
  const user = await ConsoleUser.create({
    email,
    name: email.split('@')[0].replace('.', ' '),
    status: 'invited',
    setupTokenHash: sha256(token),
    setupExpiresAt: DateTime.now().plus({ hours: 1 }),
    failedLogins: 0,
  })
  const role = await db.from('console_roles').where('slug', roleSlug).first()
  await db.table('console_user_roles').insert({ user_id: user.id, role_id: role.id, created_at: new Date() })
  return { user, token }
}

async function completeSetup(client: ApiClient, token: string) {
  const info = await client.get(`/api/auth/setup/${token}`)
  info.assertStatus(200)
  const secret = info.body().secret as string
  const res = await client
    .post(`/api/auth/setup/${token}`)
    .header('origin', ORIGIN)
    .json({ password: PASSWORD, code: hotp(secret, timeStep()) })
  res.assertStatus(200)
  return res.body().recoveryCodes as string[]
}

async function signIn(client: ApiClient, email: string, userId: number): Promise<Session> {
  const login = await client.post('/api/auth/login').header('origin', ORIGIN).json({ email, password: PASSWORD })
  login.assertStatus(200)
  const pending = String(login.headers()['set-cookie']).split(';')[0]
  const mfa = await client
    .post('/api/auth/mfa')
    .header('origin', ORIGIN)
    .header('cookie', pending)
    .header('x-csrf-token', login.body().csrfToken)
    .json({ code: await freshCode(userId) })
  mfa.assertStatus(200)
  const cookie = String(mfa.headers()['set-cookie']).split(';')[0]
  const me = await client.get('/api/auth/me').header('cookie', cookie)
  me.assertStatus(200)
  return { cookie, csrf: me.body().csrfToken, userId }
}

/** Sets the second sign-in step for the tests (the group restores what was there). */
async function setMfaMethod(method: 'email' | 'totp' | 'off') {
  await db.from('console_settings').where('key', 'mfa_method').delete()
  await db.table('console_settings').insert({ key: 'mfa_method', value: JSON.stringify(method), updated_at: new Date() })
  settingsService.clearCache()
}

/** The newest sign-in code emailed to an address (development outbox: api/tmp/mail). */
async function latestEmailCode(email: string) {
  const dir = app.makePath('tmp', 'mail')
  const files = (await readdir(dir)).filter((f) => f.includes(email.replace(/[^a-z0-9@.]/gi, '_'))).sort()
  const mail = JSON.parse(await readFile(`${dir}/${files[files.length - 1]}`, 'utf8'))
  return String(mail.subject).slice(0, 6)
}

function as(client: ApiClient, s: Session, method: 'get' | 'post' | 'put' | 'delete', url: string): ApiRequest {
  return client[method](url).header('origin', ORIGIN).header('cookie', s.cookie).header('x-csrf-token', s.csrf)
}

test.group('Console end to end', (group) => {
  let previousMfa: unknown = null
  group.setup(async () => {
    previousMfa = (await db.from('console_settings').where('key', 'mfa_method').first())?.value ?? null
    // Most tests drive authenticator codes; the email-code test switches for itself.
    await setMfaMethod('totp')
    await cleanup()
    await rbacService.syncSystemRoles()
    await db.table('users').insert({ id: LEARNER, phone: '9000002001', name: 'Console Test Learner', email: 'learner2001@test.local' })
  })
  group.teardown(async () => {
    await cleanup()
    await db.from('console_settings').where('key', 'mfa_method').delete()
    if (previousMfa !== null) {
      const value = typeof previousMfa === 'string' ? previousMfa : JSON.stringify(previousMfa)
      await db.table('console_settings').insert({ key: 'mfa_method', value, updated_at: new Date() })
    }
    settingsService.clearCache()
  })

  test('invite → setup → sign in → roles, grants, approvals, erase, audit', async ({ client, assert }) => {
    // --- a super admin signs in with password + MFA
    const a = await invitedUser('owner@test.local', 'super_admin')
    const recovery = await completeSetup(client, a.token)
    assert.lengthOf(recovery, 10)
    const admin = await signIn(client, 'owner@test.local', a.user.id)

    // --- CSRF / origin defences
    const noCsrf = await client.post('/api/auth/logout').header('origin', ORIGIN).header('cookie', admin.cookie).json({})
    noCsrf.assertStatus(403)
    assert.equal(noCsrf.body().error.code, 'BAD_CSRF')
    const badOrigin = await client
      .post('/api/auth/logout')
      .header('origin', 'https://evil.example')
      .header('cookie', admin.cookie)
      .header('x-csrf-token', admin.csrf)
      .json({})
    badOrigin.assertStatus(403)
    assert.equal(badOrigin.body().error.code, 'BAD_ORIGIN')

    // --- invite a support agent through the API
    const roles = await as(client, admin, 'get', '/api/roles')
    const support = roles.body().roles.find((r: { slug: string }) => r.slug === 'support_agent')
    const invite = await as(client, admin, 'post', '/api/staff').json({
      email: 'agent@test.local',
      name: 'Agent Test',
      roles: [support.id],
      reason: 'New support hire (test)',
    })
    invite.assertStatus(200)
    const agentToken = String(invite.body().setupLink).split('/setup/')[1]
    await completeSetup(client, agentToken)
    const agentId = invite.body().user.id
    const agent = await signIn(client, 'agent@test.local', agentId)

    // --- the agent can't see staff, can't erase memory, can't approve
    const staff = await as(client, agent, 'get', '/api/staff')
    staff.assertStatus(403)
    assert.equal(staff.body().error.code, 'FORBIDDEN')
    const denied = await db.from('console_audit_logs').where('actor_id', agentId).where('action', 'access.denied').first()
    assert.exists(denied, 'denials are audited')

    // --- a class for the test learner: 30 min total, 10 spent, ledger has a free 30
    const [chatId] = await db.table('ai_tutor_chats').insert({
      user_id: LEARNER,
      quiz_id: 1,
      quiz_question_id: 77,
      status: 'paused',
      total_minutes: 30,
      remaining_minutes: 20,
      time_spent: 10,
      lesson_topic: 'Console test lesson',
      created_at: new Date(),
      updated_at: new Date(),
    })
    await db.table('ai_tutor_time_logs').insert({
      user_id: LEARNER,
      quiz_question_id: 77,
      ai_tutor_chat_id: chatId,
      source: 'free',
      minutes_added: 30,
      previous_total: 0,
      new_total: 30,
      created_at: new Date(),
    })

    const list = await as(client, agent, 'get', `/api/tutor/classes?userId=${LEARNER}`)
    list.assertStatus(200)
    assert.equal(list.body().data[0].learner_name, 'C••• T••• L•••', 'names are masked without PII access')

    // --- small grant runs at once
    const small = await as(client, agent, 'post', `/api/tutor/classes/${chatId}/grant`).json({
      minutes: 15,
      reason: 'Audio dropped mid-class (test)',
    })
    small.assertStatus(200)
    assert.equal(small.body().status, 'done')
    assert.equal(small.body().new_total, 45)
    assert.equal(small.body().remaining, 35)
    const log = await db.from('ai_tutor_time_logs').where('ai_tutor_chat_id', chatId).where('source', 'console_grant').first()
    assert.equal(log.minutes_added, 15)

    // --- a big grant waits for a second person
    const big = await as(client, agent, 'post', `/api/tutor/classes/${chatId}/grant`).json({
      minutes: 120,
      reason: 'Goodwill for repeated outages (test)',
    })
    big.assertStatus(200)
    assert.equal(big.body().status, 'pending_approval')
    const approvalId = big.body().approvalId
    const selfDecide = await as(client, agent, 'post', `/api/approvals/${approvalId}/decide`).json({
      decision: 'approve',
      note: 'approving my own',
    })
    selfDecide.assertStatus(403)
    const chatBefore = await db.from('ai_tutor_chats').where('id', chatId).first()
    assert.equal(chatBefore.total_minutes, 45, 'nothing granted before approval')

    const approve = await as(client, admin, 'post', `/api/approvals/${approvalId}/decide`).json({
      decision: 'approve',
      note: 'Checked the outage report',
    })
    approve.assertStatus(200)
    assert.equal(approve.body().status, 'approved')
    const chatAfter = await db.from('ai_tutor_chats').where('id', chatId).first()
    assert.equal(chatAfter.total_minutes, 165)
    assert.equal(chatAfter.remaining_minutes, 155)
    const again = await as(client, admin, 'post', `/api/approvals/${approvalId}/decide`).json({
      decision: 'approve',
      note: 'double click',
    })
    again.assertStatus(409)

    // --- memory erase (privacy request) with the tutor's tombstone semantics
    await db.table('ai_tutor_learner_memories').insert({
      user_id: LEARNER,
      scope: 'profile',
      memory: JSON.stringify({ facts: ['likes cricket'] }),
      version: 4,
      created_at: new Date(),
      updated_at: new Date(),
    })
    await db.table('ai_tutor_session_summaries').insert({
      ai_tutor_chat_id: chatId,
      user_id: LEARNER,
      summary: 'Practised greetings',
      created_at: new Date(),
      updated_at: new Date(),
    })
    const agentErase = await as(client, agent, 'post', `/api/learners/${LEARNER}/memory/erase`).json({ reason: 'not allowed' })
    agentErase.assertStatus(403)
    const erase = await as(client, admin, 'post', `/api/learners/${LEARNER}/memory/erase`).json({
      reason: 'Learner asked to be forgotten (ticket T-1)',
    })
    erase.assertStatus(200)
    assert.deepEqual(erase.body(), { version: 5, summariesDeleted: 1 })
    const memory = await db.from('ai_tutor_learner_memories').where('user_id', LEARNER).first()
    assert.equal(memory.version, 5)
    assert.equal(memory.erased_version, 5)
    assert.deepEqual(typeof memory.memory === 'string' ? JSON.parse(memory.memory) : memory.memory, {})

    // --- transcript needs a reason and is audited
    const noReason = await as(client, agent, 'post', `/api/tutor/classes/${chatId}/transcript`).json({})
    noReason.assertStatus(422)
    const transcript = await as(client, agent, 'post', `/api/tutor/classes/${chatId}/transcript`).json({
      reason: 'Learner says tutor cut them off',
    })
    transcript.assertStatus(200)

    // --- guard rails on access management
    const selfRoles = await as(client, admin, 'put', `/api/staff/${admin.userId}/roles`).json({ roles: [], reason: 'testing self' })
    selfRoles.assertStatus(403)
    const disable = await as(client, admin, 'post', `/api/staff/${agentId}/disable`).json({ reason: 'Left the company (test)' })
    disable.assertStatus(200)
    const agentAfter = await client.get('/api/auth/me').header('cookie', agent.cookie)
    agentAfter.assertStatus(401)

    // --- the audit chain verifies, and detects an edited row
    const verify = await as(client, admin, 'post', '/api/audit/verify').json({})
    verify.assertStatus(200)
    assert.isTrue(verify.body().ok)
    const row = await db.from('console_audit_logs').where('action', 'tutor.memory.erased').orderBy('id', 'desc').first()
    await db.from('console_audit_logs').where('id', row.id).update({ reason: 'nothing to see here' })
    const tampered = await as(client, admin, 'post', '/api/audit/verify').json({})
    assert.isFalse(tampered.body().ok)
    assert.equal(tampered.body().brokenAt, row.id)
    await db.from('console_audit_logs').where('id', row.id).update({ reason: row.reason })
    const restored = await as(client, admin, 'post', '/api/audit/verify').json({})
    assert.isTrue(restored.body().ok)
  }).timeout(60_000)

  test('AI Pro without payment: preview, grant, approval, extend, end; minutes up and down; insights', async ({ client, assert }) => {
    const a = await invitedUser('pro-owner@test.local', 'super_admin')
    await completeSetup(client, a.token)
    const admin = await signIn(client, 'pro-owner@test.local', a.user.id)
    const o = await invitedUser('pro-ops@test.local', 'ops_manager')
    await completeSetup(client, o.token)
    const ops = await signIn(client, 'pro-ops@test.local', o.user.id)

    // A course with 3 lessons, one PDF learn card each, and an AI package
    await db.table('courses').insert({ id: 9101, title: 'Test course' })
    await db.table('course_lesson_packages').insert({ course_id: 9101, name: 'Premium', status: 'active', has_ai_tutor: 1, ai_chat_duration: 30 })
    for (let n = 1; n <= 3; n++) {
      await db.table('course_lessons').insert({ course_id: 9101, name: `L${n}`, quiz_id: 910_000 + n, course_level: 'A1.1', lesson_number: n, is_deleted: 0 })
      await db.table('quiz_questions').insert({ quiz_id: 910_000 + n, type_code: 'LEARN_CARD', sub_type_code: 'PDF' })
    }
    // The course picker lists titled courses that have lessons
    const catalog = await as(client, ops, 'get', '/api/tutor/ai-pro/catalog')
    catalog.assertStatus(200)
    assert.deepInclude(catalog.body().courses, { id: 9101, name: 'Test course' })
    const levels = await as(client, ops, 'get', '/api/tutor/ai-pro/catalog?courseId=9101')
    assert.deepEqual(levels.body().levels, [{ level: 'A1.1', lessons: 3, first: 1, last: 3 }])

    const body = {
      course_id: 9101,
      level_name: 'A1.1',
      from_lesson: 1,
      to_lesson: 3,
      minutes_per_card: 30,
      validity_days: 30,
      with_plan: true,
      with_access: true,
    }

    const preview = await as(client, ops, 'post', `/api/learners/${LEARNER}/ai-pro/preview`).json(body)
    preview.assertStatus(200)
    assert.equal(preview.body().cardCount, 3)
    assert.equal(preview.body().minutesTotal, 90)
    assert.isTrue(preview.body().createsPlan)
    assert.isFalse(preview.body().needsApproval)

    const grant = await as(client, ops, 'post', `/api/learners/${LEARNER}/ai-pro`).json({ ...body, reason: 'Scholarship learner (test)' })
    grant.assertStatus(200)
    assert.equal(grant.body().status, 'done')
    assert.equal(grant.body().cards_granted, 3)
    const booking = await db.from('course_lesson_package_bookings').where('user_id', LEARNER).first()
    assert.equal(booking.has_ai_tutor, 1)
    assert.equal(Number(booking.selling_price), 0)
    assert.isAbove(Number(booking.expire_on), Date.now() + 29 * 86_400_000)
    assert.lengthOf(await db.from('course_lesson_subscriptions').where('user_id', LEARNER), 3)
    const logs = await db.from('ai_tutor_time_logs').where('user_id', LEARNER).where('source', 'console_ai_pro')
    assert.lengthOf(logs, 3)

    // Granting the same again changes nothing (like the CLI, minutes are not doubled)
    const again = await as(client, ops, 'post', `/api/learners/${LEARNER}/ai-pro`).json({ ...body, reason: 'double click (test)' })
    again.assertStatus(409)

    // A long grant (another level) waits for approval; the requester can't approve it
    await db.table('course_lessons').insert({ course_id: 9101, name: 'L1 (A1.2)', quiz_id: 910_003, course_level: 'A1.2', lesson_number: 1, is_deleted: 0 })
    const longGrant = await as(client, ops, 'post', `/api/learners/${LEARNER}/ai-pro`).json({
      ...body,
      level_name: 'A1.2',
      from_lesson: 1,
      to_lesson: 1,
      validity_days: 180,
      reason: 'Six months for a partner school (test)',
    })
    longGrant.assertStatus(200)
    assert.equal(longGrant.body().status, 'pending_approval')
    const own = await as(client, ops, 'post', `/api/approvals/${longGrant.body().approvalId}/decide`).json({ decision: 'approve', note: 'my own request' })
    own.assertStatus(403)
    const approved = await as(client, admin, 'post', `/api/approvals/${longGrant.body().approvalId}/decide`).json({
      decision: 'approve',
      note: 'Partner school agreement on file',
    })
    approved.assertStatus(200)
    assert.equal(approved.body().status, 'approved')
    const a12 = await db.from('course_lesson_package_bookings').where('user_id', LEARNER).where('level_name', 'A1.2').first()
    assert.isAbove(Number(a12.expire_on), Date.now() + 179 * 86_400_000)

    // Extend, then end and take back unused minutes
    const list = await as(client, ops, 'get', `/api/learners/${LEARNER}/ai-pro`)
    list.assertStatus(200)
    const grantRow = list.body().grants.find((g: { level: string }) => g.level === 'A1.1')
    assert.equal(grantRow.status, 'active')
    assert.isTrue(list.body().plans.every((p: { kind: string }) => p.kind === 'console'))
    const extend = await as(client, ops, 'post', `/api/ai-pro/${grantRow.id}/extend`).json({ days: 10, reason: 'Exam next week (test)' })
    extend.assertStatus(200)
    assert.isAbove(extend.body().expiresAt, grantRow.expiresAt + 9 * 86_400_000)

    const chat = await db.from('ai_tutor_chats').where('user_id', LEARNER).where('quiz_id', 910_001).first()
    await db.from('ai_tutor_chats').where('id', chat.id).update({ time_spent: 10, remaining_minutes: 20 })
    const end = await as(client, ops, 'post', `/api/ai-pro/${grantRow.id}/end`).json({
      remove_unused_minutes: true,
      reason: 'Scholarship ended (test)',
    })
    end.assertStatus(200)
    assert.equal(end.body().minutesRemoved, 20 + 30 + 30)
    const ended = await db.from('course_lesson_package_bookings').where('id', booking.id).first()
    assert.isAtMost(Number(ended.expire_on), Date.now())
    const chatAfter = await db.from('ai_tutor_chats').where('id', chat.id).first()
    assert.equal(chatAfter.total_minutes, 10)
    assert.equal(chatAfter.remaining_minutes, 0)

    // Minutes up and down on one class; never below what was used
    const up = await as(client, ops, 'post', `/api/tutor/classes/${chat.id}/grant`).json({ minutes: 20, reason: 'Make-up class (test)' })
    up.assertStatus(200)
    assert.equal(up.body().new_total, 30)
    const tooMuch = await as(client, ops, 'post', `/api/tutor/classes/${chat.id}/grant`).json({ minutes: -25, reason: 'Wrong grant (test)' })
    tooMuch.assertStatus(409)
    assert.equal(tooMuch.body().error.code, 'MINUTES_USED')
    const down = await as(client, ops, 'post', `/api/tutor/classes/${chat.id}/grant`).json({ minutes: -20, reason: 'Wrong grant (test)' })
    down.assertStatus(200)
    assert.equal(down.body().new_total, 10)

    // Insights answer for every range; cost needs its own permission
    for (const path of ['insights/users?days=7', 'insights/engagement?days=30', 'insights/tutor?days=30', 'insights/highlights', 'insights/cost?days=30']) {
      const res = await as(client, admin, 'get', `/api/${path}`)
      res.assertStatus(200)
    }
    const cost = await as(client, admin, 'get', '/api/insights/cost?days=30')
    assert.isBoolean(cost.body().recorded)
    assert.isAbove(cost.body().engines[0].assumedPerMinuteInr, 0)
    assert.isTrue(cost.body().byProvider.some((p: { provider: string }) => p.provider === 'sarvam'))
    const opsCost = await as(client, ops, 'get', '/api/insights/cost?days=30')
    opsCost.assertStatus(403)
    const badModel = await as(client, admin, 'put', '/api/insights/cost-model').json({
      model: { ...cost.body().model, usdToInr: -5 },
      reason: 'testing validation',
    })
    badModel.assertStatus(422)

    // Reconciliation: enter a bill, see it next to the computed figure
    const month = new Date(Date.now() + 19_800_000).toISOString().slice(0, 7)
    const bill = await as(client, admin, 'put', '/api/insights/invoices').json({
      month,
      provider: 'sarvam',
      amount_inr: 1234.5,
      reason: 'October Sarvam credits (test)',
    })
    bill.assertStatus(200)
    assert.equal(bill.body().find((r: { month: string; provider: string }) => r.month === month && r.provider === 'sarvam')?.billedInr, 1234.5)
    await db.from('console_cost_invoices').where('month', month).where('provider', 'sarvam').delete()

    // Exact cost once the tutor API's usage table exists (docs/AI_USAGE_SPEC.md)
    const usageTable = await db.from('information_schema.tables').whereRaw('table_schema = DATABASE()').where('table_name', 'ai_tutor_session_usage').first()
    if (usageTable) {
      const now = new Date()
      const row = (kind: string, provider: string, model: string, unit: string, quantity: number) => ({
        ai_tutor_chat_id: chat.id, user_id: LEARNER, job_id: 'test-job', engine: 'sarvam', language: 'kn-IN', explain_language: 'en-IN',
        kind, provider, model, unit, quantity, created_at: now, updated_at: now,
      })
      await db.table('ai_tutor_session_usage').multiInsert([
        row('stt', 'sarvam', 'saaras:v3-realtime', 'audio_seconds', 3600), // ₹30
        row('tts', 'sarvam', 'bulbul:v3', 'characters', 10_000), // ₹30
        row('tts', 'acme', 'voice-1', 'characters', 500), // unpriced
      ])
      const classCost = await as(client, admin, 'get', `/api/tutor/classes/${chat.id}/cost`)
      classCost.assertStatus(200)
      assert.closeTo(classCost.body().totalInr, 60, 1e-6)
      assert.isTrue(classCost.body().items.some((i: { priced: boolean }) => !i.priced))
      await db.from('ai_tutor_session_usage').where('ai_tutor_chat_id', chat.id).delete()
    }
  }).timeout(90_000)

  test('any one Super Admin makes a Super Admin directly (invite or roles); links can be reissued; others cannot', async ({ client, assert }) => {
    const a = await invitedUser('sa-one@test.local', 'super_admin')
    await completeSetup(client, a.token)
    const sa = await signIn(client, 'sa-one@test.local', a.user.id)
    const roles = (await as(client, sa, 'get', '/api/roles')).body().roles as { id: number; slug: string }[]
    const superRole = roles.find((r) => r.slug === 'super_admin')!
    const support = roles.find((r) => r.slug === 'support_agent')!

    // Other active Super Admins exist locally; still no second approval: granted at once
    const invite = await as(client, sa, 'post', '/api/staff').json({
      email: 'sa-two@test.local',
      name: 'Second Owner',
      roles: [superRole.id],
      reason: 'Co-founder joins as the second Super Admin (test)',
    })
    invite.assertStatus(200)
    assert.include(invite.body().setupLink, '/setup/')
    assert.equal(invite.body().superAdmin, 'granted')
    assert.isNull(invite.body().approvalId)
    const hasSuperAdmin = async (userId: number) =>
      !!(await db.from('console_user_roles').where({ user_id: userId, role_id: superRole.id }).first())
    assert.isTrue(await hasSuperAdmin(invite.body().user.id))
    assert.isNull(await db.from('console_approval_requests').where('requested_by', a.user.id).first())

    // Reissue: the old link stops working, the new one works
    const oldToken = String(invite.body().setupLink).split('/setup/')[1]
    const reissue = await as(client, sa, 'post', `/api/staff/${invite.body().user.id}/invite-link`).json({})
    reissue.assertStatus(200)
    const newToken = String(reissue.body().setupLink).split('/setup/')[1]
    assert.notEqual(newToken, oldToken)
    ;(await client.get(`/api/auth/setup/${oldToken}`)).assertStatus(404)
    ;(await client.get(`/api/auth/setup/${newToken}`)).assertStatus(200)

    // A non-Super-Admin can't hand out Super Admin
    const pa = await invitedUser('pa-one@test.local', 'platform_admin')
    await completeSetup(client, pa.token)
    const platform = await signIn(client, 'pa-one@test.local', pa.user.id)
    const denied = await as(client, platform, 'post', '/api/staff').json({
      email: 'sneaky@test.local',
      name: 'Sneaky',
      roles: [superRole.id, support.id],
      reason: 'should not work (test)',
    })
    denied.assertStatus(403)

    // …and a Super Admin promotes an existing staff member directly
    const promoted = await as(client, sa, 'put', `/api/staff/${pa.user.id}/roles`).json({
      roles: [superRole.id],
      reason: 'Head of ops becomes a Super Admin (test)',
    })
    promoted.assertStatus(200)
    assert.equal(promoted.body().status, 'done')
    assert.isTrue(await hasSuperAdmin(pa.user.id))
    assert.isNull(await db.from('console_approval_requests').where('requested_by', a.user.id).first())
  }).timeout(60_000)

  test('email sign-in codes (default) and password-only sign-in', async ({ client, assert }) => {
    await setMfaMethod('email')
    try {
      const e = await invitedUser('mailer@test.local', 'auditor')
      // With email codes, setup needs only a password: no QR, no recovery codes
      const info = await client.get(`/api/auth/setup/${e.token}`)
      assert.equal(info.body().mfaMethod, 'email')
      assert.isNull(info.body().secret)
      const setup = await client.post(`/api/auth/setup/${e.token}`).header('origin', ORIGIN).json({ password: PASSWORD })
      setup.assertStatus(200)
      assert.deepEqual(setup.body().recoveryCodes, [])

      const login = await client.post('/api/auth/login').header('origin', ORIGIN).json({ email: 'mailer@test.local', password: PASSWORD })
      login.assertStatus(200)
      assert.equal(login.body().method, 'email')
      assert.equal(login.body().sentTo, 'm•••@test.local')
      const pending = String(login.headers()['set-cookie']).split(';')[0]
      const send = (path: string, body: object) =>
        client.post(path).header('origin', ORIGIN).header('cookie', pending).header('x-csrf-token', login.body().csrfToken).json(body)
      // An immediate resend is throttled; a wrong code is refused
      ;(await send('/api/auth/mfa/resend', {})).assertStatus(429)
      ;(await send('/api/auth/mfa', { code: '000000' })).assertStatus(401)
      const mfa = await send('/api/auth/mfa', { code: await latestEmailCode('mailer@test.local') })
      mfa.assertStatus(200)
      const cookie = String(mfa.headers()['set-cookie']).split(';')[0]
      const me = await client.get('/api/auth/me').header('cookie', cookie)
      assert.equal(me.body().policy.mfaMethod, 'email')
      const session = { cookie, csrf: me.body().csrfToken, userId: e.user.id }

      // Step-up by email
      ;(await as(client, session, 'post', '/api/auth/step-up/send').json({})).assertStatus(200)
      ;(await as(client, session, 'post', '/api/auth/step-up').json({ code: await latestEmailCode('mailer@test.local') })).assertStatus(200)

      // Password only: straight in, and step-up asks for the password again
      await setMfaMethod('off')
      const plain = await client.post('/api/auth/login').header('origin', ORIGIN).json({ email: 'mailer@test.local', password: PASSWORD })
      plain.assertStatus(200)
      assert.equal(plain.body().next, 'app')
      const plainCookie = String(plain.headers()['set-cookie']).split(';')[0]
      const plainMe = await client.get('/api/auth/me').header('cookie', plainCookie)
      plainMe.assertStatus(200)
      const plainSession = { cookie: plainCookie, csrf: plainMe.body().csrfToken, userId: e.user.id }
      ;(await as(client, plainSession, 'post', '/api/auth/step-up').json({ password: 'wrong password here' })).assertStatus(401)
      ;(await as(client, plainSession, 'post', '/api/auth/step-up').json({ password: PASSWORD })).assertStatus(200)
    } finally {
      await setMfaMethod('totp')
    }
  }).timeout(60_000)

  test('learner names: the app placeholder, a CRM enquiry name, and renaming', async ({ client, assert }) => {
    const a = await invitedUser('names-owner@test.local', 'super_admin')
    await completeSetup(client, a.token)
    const admin = await signIn(client, 'names-owner@test.local', a.user.id)
    const s = await invitedUser('names-support@test.local', 'support_agent')
    await completeSetup(client, s.token)
    const support = await signIn(client, 'names-support@test.local', s.user.id)

    // Phone sign-ups keep the app's placeholder "User": shown as no name
    await db.from('users').where('id', LEARNER).update({ name: 'User' })
    const placeholder = await as(client, admin, 'get', `/api/learners/${LEARNER}`)
    placeholder.assertStatus(200)
    assert.isNull(placeholder.body().learner.name)
    assert.isNull(placeholder.body().learner.nameSource)

    // A CRM enquiry with a real name fills the gap, marked as such
    await db.table('direct_leads').insert({ user_id: LEARNER, name: 'User', phone: '9000002001' })
    await db.table('direct_leads').insert({ user_id: LEARNER, name: 'Priya Sharma', phone: '9000002001' })
    const fromLead = await as(client, admin, 'get', `/api/learners?q=${LEARNER}`)
    assert.equal(fromLead.body().data[0].name, 'Priya Sharma')
    assert.equal(fromLead.body().data[0].nameSource, 'enquiry')

    // Renaming needs learners.manage; the name is validated, tidied and audited
    const denied = await as(client, support, 'post', `/api/learners/${LEARNER}/name`).json({ name: 'Priya Sharma', reason: 'learner asked (test)' })
    denied.assertStatus(403)
    const bad = await as(client, admin, 'post', `/api/learners/${LEARNER}/name`).json({ name: '<b>Priya</b>', reason: 'learner asked (test)' })
    bad.assertStatus(422)
    const renamed = await as(client, admin, 'post', `/api/learners/${LEARNER}/name`).json({ name: '  Priya   Sharma ', reason: 'Learner told support on a call (test)' })
    renamed.assertStatus(200)
    assert.equal((await db.from('users').where('id', LEARNER).first()).name, 'Priya Sharma')
    const after = await as(client, admin, 'get', `/api/learners/${LEARNER}`)
    assert.equal(after.body().learner.nameSource, 'account')
    const audit = await db.from('console_audit_logs').where('action', 'learners.renamed').where('target_id', String(LEARNER)).orderBy('id', 'desc').first()
    assert.equal(audit.reason, 'Learner told support on a call (test)')
    await db.from('users').where('id', LEARNER).update({ name: 'Console Test Learner' })
  })

  test('wrong passwords lock the account; the message never reveals whether it exists', async ({ client, assert }) => {
    const b = await invitedUser('locked@test.local', 'auditor')
    await completeSetup(client, b.token)
    const attempt = (email: string, password: string) =>
      client.post('/api/auth/login').header('origin', ORIGIN).json({ email, password })

    const unknown = await attempt('nobody@test.local', 'whatever-password')
    const wrong = await attempt('locked@test.local', 'whatever-password')
    unknown.assertStatus(401)
    wrong.assertStatus(401)
    assert.equal(unknown.body().error.message, wrong.body().error.message)

    for (let i = 0; i < 4; i++) await attempt('locked@test.local', 'still-wrong-password')
    const locked = await attempt('locked@test.local', PASSWORD)
    locked.assertStatus(423)
    assert.equal(locked.body().error.code, 'LOCKED')
  }).timeout(60_000)
})
