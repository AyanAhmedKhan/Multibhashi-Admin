import { test } from '@japa/runner'
import { TUTOR_GEMINI_PROJECT, attribute, describeRules, openaiIsQuiz, splitScope, type AttributionRules } from '#services/analytics/cost_attribution'
import { openaiDaySplit } from '#services/analytics/full_bill'
import { OpenAiUsageClient, type FetchLike } from '#services/analytics/openai_usage'

const rules = (over: Partial<AttributionRules> = {}): AttributionRules => ({
  speechProject: 'multibhashi-android-app',
  openaiQuizProjects: [],
  openaiQuizKeys: [],
  tutorGcpProjects: [TUTOR_GEMINI_PROJECT],
  ...over,
})
const g = (scope: string, item: string) => ({ provider: 'google', scope, item, source: 'gcp_billing_export' })
const o = (scope: string, source = 'openai_costs_api') => ({ provider: 'openai', scope, item: 'gpt-4o-mini-2024-07-18, input', source })

test.group('Cost attribution (read-time rules over the whole bill)', () => {
  test('GCP: the tutor’s Gemini project, the speech project’s speech SKUs, everything else', ({ assert }) => {
    assert.deepEqual(attribute(g(TUTOR_GEMINI_PROJECT, 'Gemini API / Generate content input'), rules()), { bucket: 'tutor', part: null })
    assert.deepEqual(attribute(g('multibhashi-android-app', 'Speech / Recognition'), rules()), { bucket: 'quizzes', part: 'speech' })
    assert.equal(attribute(g('multibhashi-android-app', 'Cloud Storage / Standard Storage Mumbai'), rules()).bucket, 'other')
    assert.equal(attribute(g('another-project', 'Speech / Recognition'), rules()).bucket, 'other', 'speech in another project is not the quiz’s')
    assert.equal(attribute(g('another-project', 'Speech / Recognition'), rules({ speechProject: null })).bucket, 'quizzes', 'no speech project set: any project')
    assert.equal(attribute(g('no-project', 'Invoice / Tax'), rules()).bucket, 'other')
  })

  test('OpenAI: no rule = the whole organisation is the quizzes’ (spec §6); project and key rules narrow it', ({ assert }) => {
    assert.isTrue(openaiIsQuiz('proj_a/key_1', rules()))
    assert.isTrue(openaiIsQuiz('proj_a', rules({ openaiQuizProjects: ['proj_a'] })))
    assert.isFalse(openaiIsQuiz('proj_b/key_1', rules({ openaiQuizProjects: ['proj_a'] })))
    assert.isTrue(openaiIsQuiz('proj_a/key_1', rules({ openaiQuizKeys: ['key_1'] })))
    assert.isFalse(openaiIsQuiz('proj_a/key_2', rules({ openaiQuizKeys: ['key_1'] })))
    assert.isNull(openaiIsQuiz('proj_a', rules({ openaiQuizKeys: ['key_1'] })), 'costs not broken down by key: can’t tell')
    assert.isFalse(openaiIsQuiz('proj_b', rules({ openaiQuizProjects: ['proj_a'], openaiQuizKeys: ['key_1'] })), 'wrong project settles it')
    assert.deepEqual(splitScope('proj_a/key_1'), { project: 'proj_a', key: 'key_1' })
    assert.deepEqual(splitScope('proj_a'), { project: 'proj_a', key: null })
    assert.deepEqual(attribute(o('proj_a/key_1'), rules({ openaiQuizKeys: ['key_9'] })), { bucket: 'other', part: null })
    assert.deepEqual(attribute(o('proj_a'), rules({ openaiQuizKeys: ['key_9'] })), { bucket: null, part: 'marking' })
  })

  test('an OpenAI day not broken down by key is split by the quiz keys’ usage at list price, never more than was charged', ({ assert }) => {
    const row = (scope: string, usd: number) => ({ day: '2026-10-28', provider: 'openai', scope, item: 'x', unit: 'tokens', quantity: 1, costUsd: usd, creditsUsd: 0, source: 'openai_costs_api' })
    const keyRule = rules({ openaiQuizKeys: ['key_quiz'] })
    const split = openaiDaySplit([row('proj_a', 1), row('proj_b', 0.5)], 40, keyRule, 100)
    assert.equal(split.total, 150)
    assert.equal(split.split.quizzes, 40)
    assert.equal(split.split.other, 110)
    assert.isTrue(split.splitByUsage)
    const capped = openaiDaySplit([row('proj_a', 0.2)], 999, keyRule, 100)
    assert.equal(capped.split.quizzes, 20, 'capped at the charge')
    const byProject = openaiDaySplit([row('proj_a/key_quiz', 1), row('proj_a/key_other', 2)], 0, keyRule, 100)
    assert.deepEqual(byProject.split, { quizzes: 100, tutor: 0, other: 200 })
    assert.isFalse(byProject.splitByUsage)
  })

  test('rules are described for the page', ({ assert }) => {
    assert.include(describeRules(rules()).speech, 'multibhashi-android-app')
    assert.include(describeRules(rules()).marking, 'all of OpenAI')
    assert.include(describeRules(rules({ openaiQuizKeys: ['key_1'] })).marking, 'key key_1')
    assert.include(describeRules(rules()).tutor, TUTOR_GEMINI_PROJECT)
  })

  test('the Costs API refusing key grouping (400) falls back to project + line item', async ({ assert }) => {
    const calls: string[] = []
    const body = { object: 'page', data: [{ object: 'bucket', start_time: 1793059200, end_time: 1793145600, results: [{ object: 'organization.costs.result', amount: { value: 0.5, currency: 'usd' }, line_item: 'gpt-4o-mini-2024-07-18, input', project_id: 'proj_a', api_key_id: null }] }], has_more: false, next_page: null }
    const fetch: FetchLike = async (url) => {
      calls.push(url)
      const keyed = new URL(url).searchParams.getAll('group_by[]').includes('api_key_id')
      return keyed
        ? { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Invalid group_by combination' } }) }
        : { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
    const costs = await new OpenAiUsageClient({ adminKey: 'sk-admin', fetch }).costs(1793059200, 1)
    assert.lengthOf(calls, 2)
    assert.isFalse(costs.byKey)
    assert.equal(costs.rows[0].scope, 'proj_a')
    assert.equal(costs.rows[0].costUsd, 0.5)
  })
})
