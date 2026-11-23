import { test } from '@japa/runner'
import type { AnswerRow } from '#services/analytics/quiz_analytics'
import {
  METRICS,
  METRIC_BY_KEY,
  answerMetrics,
  attemptMetrics,
  bucketOf,
  combine,
  costMetrics,
  eventMetrics,
  histQuantile,
  isFinal,
  seg,
  stuckAfter,
  type AttemptRow,
  type CostDay,
  type MetricEvent,
  type MetricRow,
} from '#services/analytics/quiz_metrics'
import { deviceMatcher, speechSeconds } from '#services/analytics/quiz_metrics_store'
import { DIRECTIONS, RELEASE_KINDS, RELEASE_SURFACES, SEED_RELEASES } from '#services/analytics/quiz_releases'

const answer = (over: Partial<AnswerRow>): AnswerRow => ({
  key: over.key ?? `course:${Math.random()}`,
  context: 'course',
  id: 1,
  logId: 10,
  userId: 100,
  quizId: 7,
  questionId: 456,
  type: 'SQ',
  day: '2026-11-10',
  startMs: null,
  endMs: null,
  words: 40,
  sentences: 3,
  chars: 200,
  relevance: 7,
  grammar: 6,
  pronunciation: 8,
  finalPercentage: 70,
  isCorrect: true,
  onTime: true,
  timeTaken: 42,
  path: 'legacy',
  scoringVersion: null,
  promptVersion: null,
  model: null,
  evaluationStatus: null,
  attempts: 1,
  failReason: null,
  failed: false,
  ...over,
})

const pick = (rows: MetricRow[], metric: string, segment = 'all', day?: string) =>
  rows.filter((r) => r.metric === metric && r.segment === segment && (!day || r.day === day))

const one = (rows: MetricRow[], metric: string, segment = 'all', day?: string) => {
  const found = pick(rows, metric, segment, day)
  if (found.length !== 1) throw new Error(`${metric}/${segment}: ${found.length} rows`)
  return found[0]
}

test.group('Quiz metrics: catalog', () => {
  test('every key is unique, every distribution has edges, every phase is a brief phase', ({ assert }) => {
    assert.equal(new Set(METRICS.map((m) => m.key)).size, METRICS.length)
    for (const m of METRICS) {
      assert.isAtMost(m.key.length, 64)
      if (m.kind === 'distribution') assert.isAbove(m.edges?.length ?? 0, 1, m.key)
      else assert.isUndefined(m.edges, m.key)
      for (const p of m.phases) assert.include(['0', '1', '2', '3', '4', '5', '6'], p, m.key)
    }
  })

  test('a value lands in the bucket whose lower edge it reaches; the last bucket is open-ended', ({ assert }) => {
    const edges = [0, 1, 10, 25]
    assert.equal(bucketOf(0, edges), 0)
    assert.equal(bucketOf(0.5, edges), 0)
    assert.equal(bucketOf(1, edges), 1)
    assert.equal(bucketOf(9.99, edges), 1)
    assert.equal(bucketOf(10, edges), 2)
    assert.equal(bucketOf(2500, edges), 3)
  })

  test('segment labels fit the column and carry no separators', ({ assert }) => {
    assert.equal(seg('device', null), 'device:unknown')
    assert.equal(seg('app', '1.0.0 (37)'), 'app:1.0.0_(37)')
    assert.isAtMost(seg('app', 'x'.repeat(200)).length, 64)
  })
})

test.group('Quiz metrics: answers', () => {
  test('Speaking and Writing rates count the right answers, by day and segment', ({ assert }) => {
    const device = (a: AnswerRow) => (a.userId === 100 ? { device: 'web', appVersion: '1.0.0+web.aaaa1111' } : null)
    const rows = answerMetrics(
      [
        answer({ words: 0, failed: false }),
        answer({ onTime: false }),
        answer({ onTime: null, isCorrect: null, failed: true }),
        answer({ type: 'WQ', words: 5, relevance: 9, userId: 200 }),
        answer({ type: 'WQ', words: 5, relevance: 3, userId: 200 }),
        answer({ type: 'WQ', words: 0, relevance: null, userId: 200 }),
        answer({ type: 'WQ', words: 150, context: 'webinar', userId: 200 }),
        answer({ day: '2026-11-12' }), // outside [from, to)
      ],
      device,
      '2026-11-10',
      '2026-11-12'
    )
    assert.equal(one(rows, 'sq_answers').num, 3)
    assert.deepInclude(one(rows, 'sq_late_share'), { num: 1, den: 2 }, 'null finished_on_time is left out')
    assert.deepInclude(one(rows, 'sq_no_speech_share'), { num: 1, den: 3 })
    assert.deepInclude(one(rows, 'sq_marking_failed_share'), { num: 1, den: 3 })
    assert.deepInclude(one(rows, 'sq_correct_share'), { num: 2, den: 2 })
    assert.equal(one(rows, 'wq_answers').num, 4)
    assert.deepInclude(one(rows, 'wq_empty_share'), { num: 1, den: 4 })
    assert.deepInclude(one(rows, 'wq_under_10_words_share'), { num: 2, den: 3 }, 'empty answers are not "under 10 words"')
    assert.deepInclude(one(rows, 'wq_short_high_relevance_share'), { num: 1, den: 2 })
    // segments
    assert.equal(one(rows, 'sq_answers', 'device:web').num, 3)
    assert.equal(one(rows, 'sq_answers', 'app:1.0.0+web.aaaa1111').num, 3)
    assert.equal(one(rows, 'wq_answers', 'device:unknown').num, 4)
    assert.equal(one(rows, 'wq_answers', 'context:webinar').num, 1)
    assert.lengthOf(pick(rows, 'sq_answers', 'all', '2026-11-12'), 0)
  })

  test('distributions keep the sum, the count and the buckets', ({ assert }) => {
    const rows = answerMetrics([answer({ type: 'WQ', words: 5 }), answer({ type: 'WQ', words: 120 }), answer({ type: 'WQ', words: 0 })], () => null, '2026-11-10', '2026-11-11')
    const words = one(rows, 'wq_words')
    assert.equal(words.num, 125)
    assert.equal(words.den, 3)
    // edges [0, 1, 10, 25, 50, 100, 150, 200, 300]
    assert.deepEqual(words.hist, [1, 1, 0, 0, 0, 1, 0, 0, 0])
    const tt = one(answerMetrics([answer({ timeTaken: 0 }), answer({ timeTaken: 33 })], () => null, '2026-11-10', '2026-11-11'), 'sq_time_taken')
    assert.equal(tt.den, 1, 'a zero time_taken is not a time')
  })

  test('evidence retries are a share of evidence-marked answers only', ({ assert }) => {
    const rows = answerMetrics(
      [answer({ path: 'evidence', attempts: 2 }), answer({ path: 'evidence', attempts: 1 }), answer({ path: 'legacy' })],
      () => null,
      '2026-11-10',
      '2026-11-11'
    )
    assert.deepInclude(one(rows, 'evidence_retried_share'), { num: 1, den: 2 })
    assert.deepInclude(one(rows, 'evidence_path_share'), { num: 2, den: 3 })
  })
})

test.group('Quiz metrics: attempts', () => {
  const attempt = (over: Partial<AttemptRow>): AttemptRow => ({
    key: 'course:1',
    context: 'course',
    logId: 1,
    userId: 100,
    quizId: 7,
    day: '2026-11-10',
    startMs: null,
    finished: true,
    answered: 5,
    speakingWriting: 1,
    lastTimedOut: false,
    ...over,
  })

  test('finished and left-after-a-timeout shares; attempts with no answer are not attempts', ({ assert }) => {
    const rows = attemptMetrics(
      [
        attempt({}),
        attempt({ finished: false, lastTimedOut: true }),
        attempt({ finished: false, lastTimedOut: false, speakingWriting: 0 }),
        attempt({ answered: 0, finished: false }),
      ],
      () => null,
      '2026-11-10',
      '2026-11-11'
    )
    assert.equal(one(rows, 'attempts_started').num, 3)
    assert.deepInclude(one(rows, 'attempt_finished_share'), { num: 1, den: 3 })
    assert.deepInclude(one(rows, 'sw_attempt_finished_share'), { num: 1, den: 2 })
    assert.deepInclude(one(rows, 'attempt_left_after_timeout_share'), { num: 1, den: 3 })
  })
})

test.group('Quiz metrics: app events', () => {
  const T0 = Date.parse('2026-11-10T10:00:00+05:30')
  const dayOf = (ms: number) => new Date(ms + 19_800_000).toISOString().slice(0, 10)
  const ev = (type: string, atMin: number, over: Partial<MetricEvent> = {}): MetricEvent => ({
    type,
    userId: 100,
    logId: 10,
    questionId: 456,
    at: T0 + atMin * 60_000,
    durationSec: null,
    error: null,
    reason: null,
    outcome: null,
    stage: null,
    ms: null,
    seconds: null,
    timedOut: null,
    hadAnswer: null,
    questionType: 'SQ',
    device: 'web',
    appVersion: null,
    os: 'ios',
    inApp: false,
    ...over,
  })

  test('recording failures are a share of started + failed, with the error as a segment', ({ assert }) => {
    const rows = eventMetrics(
      [ev('quiz_record_started', 0), ev('quiz_record_started', 1), ev('quiz_record_failed', 2, { error: 'NotAllowedError', inApp: true })],
      dayOf,
      '2026-11-10',
      '2026-11-11'
    )
    assert.deepInclude(one(rows, 'ev_record_failed_share'), { num: 1, den: 3 })
    assert.equal(one(rows, 'ev_record_failed', 'error:NotAllowedError').num, 1)
    assert.equal(one(rows, 'ev_record_failed', 'in_app:yes').num, 1)
    assert.equal(one(rows, 'ev_record_started', 'os:ios').num, 2)
  })

  test('submit failures are per answer submitted; timeouts per question shown', ({ assert }) => {
    const rows = eventMetrics(
      [
        ev('quiz_question_shown', 0),
        ev('quiz_question_shown', 1, { questionId: 457, questionType: 'WQ' }),
        ev('quiz_question_shown', 2, { questionId: 458, questionType: 'MCQ' }),
        ev('quiz_answer_submitted', 3),
        ev('quiz_answer_submitted', 4, { questionId: 457, questionType: 'WQ' }),
        ev('quiz_submit_failed', 5, { stage: 'stt', error: 'ECONNABORTED' }),
        ev('quiz_question_timeout', 6, { questionId: 457, questionType: 'WQ' }),
        ev('quiz_paste_blocked', 7, { questionId: 457, questionType: 'WQ' }),
      ],
      dayOf,
      '2026-11-10',
      '2026-11-11'
    )
    assert.equal(one(rows, 'ev_sq_shown').num, 1)
    assert.equal(one(rows, 'ev_wq_shown').num, 1)
    assert.deepInclude(one(rows, 'ev_submit_failed_rate'), { num: 1, den: 2 })
    assert.equal(one(rows, 'ev_submit_failed', 'stage:stt').num, 1)
    assert.deepInclude(one(rows, 'ev_timeout_rate'), { num: 1, den: 2 }, 'choice questions are not counted')
    assert.deepInclude(one(rows, 'ev_paste_blocked_rate'), { num: 1, den: 1 })
  })

  test('stuck after a timeout: no feedback within 10 min and no other question within 30 min', ({ assert }) => {
    const timeout = ev('quiz_question_timeout', 0)
    assert.isTrue(stuckAfter(timeout, [timeout]), 'nothing happened after it')
    assert.isFalse(stuckAfter(timeout, [timeout, ev('quiz_feedback_shown', 2)]), 'feedback came')
    assert.isTrue(stuckAfter(timeout, [timeout, ev('quiz_feedback_shown', 12)]), 'feedback came too late')
    assert.isFalse(stuckAfter(timeout, [timeout, ev('quiz_question_shown', 20, { questionId: 999 })]), 'moved on')
    assert.isTrue(stuckAfter(timeout, [timeout, ev('quiz_question_shown', 31, { questionId: 999 })]), 'moved on only after 30 min')
    assert.isTrue(stuckAfter(timeout, [timeout, ev('quiz_question_shown', 5, { questionId: 999, logId: 11 })]), 'another attempt is not this one')
    assert.isTrue(stuckAfter(timeout, [timeout, ev('quiz_question_shown', 5)]), 'the same question again is not moving on')
  })

  test('the lookahead past the window decides "stuck" but is not counted itself', ({ assert }) => {
    const rows = eventMetrics(
      [
        ev('quiz_question_shown', -1),
        ev('quiz_question_timeout', 0),
        ev('quiz_question_timeout', 60 * 13 + 50, { questionId: 457 }), // 23:50 IST
        ev('quiz_question_shown', 60 * 14 + 5, { questionId: 458 }), // 00:05 IST next day
      ],
      dayOf,
      '2026-11-10',
      '2026-11-11'
    )
    assert.deepInclude(one(rows, 'ev_timeout_stuck_share'), { num: 1, den: 2 })
    assert.lengthOf(pick(rows, 'ev_sq_shown', 'all', '2026-11-11'), 0)
  })

  test('re-recording is per Speaking question, attempt and day', ({ assert }) => {
    const rows = eventMetrics(
      [
        ev('quiz_record_stopped', 0, { seconds: 4 }),
        ev('quiz_record_stopped', 1, { seconds: 31 }),
        ev('quiz_record_stopped', 2, { seconds: 12, questionId: 457 }),
      ],
      dayOf,
      '2026-11-10',
      '2026-11-11'
    )
    assert.deepInclude(one(rows, 'ev_rerecord_share'), { num: 1, den: 2 })
    assert.equal(one(rows, 'ev_recorded_seconds').den, 3)
  })
})

test.group('Quiz metrics: cost', () => {
  const day = (over: Partial<CostDay>): CostDay => ({
    day: '2026-11-10',
    speechInr: 1300,
    speechBasis: 'actual',
    markingInr: 600,
    markingBasis: 'usage',
    sqAnswers: 2000,
    markedAnswers: 3500,
    answers: 3600,
    finishedSwAttempts: 400,
    billedSeconds: 51_200,
    openaiRequests: 11_200,
    openaiTokens: 30_600_000,
    ...over,
  })

  test('per-answer figures keep their numerator and denominator; mixed bases take the weaker', ({ assert }) => {
    const rows = costMetrics([day({})])
    assert.deepInclude(one(rows, 'cost_speech_per_sq_inr'), { num: 1300, den: 2000, basis: 'actual' })
    assert.deepInclude(one(rows, 'cost_marking_per_answer_inr'), { num: 600, den: 3500, basis: 'usage' })
    assert.deepInclude(one(rows, 'cost_per_answer_inr'), { num: 1900, den: 3600, basis: 'usage' })
    assert.deepInclude(one(rows, 'stt_billed_seconds_per_sq'), { num: 51_200, den: 2000 })
    assert.deepInclude(one(rows, 'openai_requests_per_marked'), { num: 11_200, den: 3500 })
  })

  test('a day the bill has not reported has no billed-quantity rows', ({ assert }) => {
    const rows = costMetrics([day({ billedSeconds: null, openaiRequests: null, openaiTokens: null, speechBasis: 'estimated' })])
    assert.lengthOf(pick(rows, 'stt_billed_seconds_per_sq'), 0)
    assert.lengthOf(pick(rows, 'openai_requests_per_marked'), 0)
    assert.equal(one(rows, 'cost_speech_inr').basis, 'estimated')
  })
})

test.group('Quiz metrics: freezing and windows', () => {
  test('a day settles after 3 days; an estimated cost day only after 21', ({ assert }) => {
    assert.isFalse(isFinal({ metric: 'sq_answers', day: '2026-11-21', basis: null }, '2026-11-23'))
    assert.isTrue(isFinal({ metric: 'sq_answers', day: '2026-11-20', basis: null }, '2026-11-23'))
    assert.isTrue(isFinal({ metric: 'cost_speech_inr', day: '2026-11-20', basis: 'actual' }, '2026-11-23'))
    assert.isFalse(isFinal({ metric: 'cost_speech_inr', day: '2026-11-10', basis: 'estimated' }, '2026-11-23'))
    assert.isTrue(isFinal({ metric: 'cost_speech_inr', day: '2026-11-01', basis: 'estimated' }, '2026-11-23'))
  })

  test('a window is SUM(num) / SUM(den), not the mean of daily rates', ({ assert }) => {
    const def = METRIC_BY_KEY.get('sq_no_speech_share')!
    const w = combine(def, [
      { num: 10, den: 100, hist: null, basis: null },
      { num: 90, den: 900, hist: null, basis: null },
      { num: 50, den: 100, hist: null, basis: null },
    ])
    assert.closeTo(w.value!, 150 / 1100, 1e-12)
    assert.equal(combine(METRIC_BY_KEY.get('sq_answers')!, [{ num: 3, den: 0, hist: null, basis: null }, { num: 4, den: 0, hist: null, basis: null }]).value, 7)
    assert.equal(combine(METRIC_BY_KEY.get('cost_per_answer_inr')!, [{ num: 1, den: 2, hist: null, basis: 'actual' }, { num: 1, den: 2, hist: null, basis: 'estimated' }]).basis, 'estimated')
  })

  test('merged histograms give a quantile inside the right bucket', ({ assert }) => {
    const def = METRIC_BY_KEY.get('wq_words')!
    const w = combine(def, [
      { num: 0, den: 2, hist: [0, 0, 0, 0, 0, 2, 0, 0, 0], basis: null },
      { num: 0, den: 2, hist: [0, 0, 0, 0, 0, 0, 2, 0, 0], basis: null },
    ])
    assert.deepEqual(w.hist, [0, 0, 0, 0, 0, 2, 2, 0, 0])
    assert.equal(histQuantile(w.hist!, def.edges!, 50), 150, 'the median sits on the 100–150 / 150–200 boundary')
    assert.equal(histQuantile([0, 0, 0, 0, 0, 0, 0, 0, 3], def.edges!, 90), 300, 'the open-ended bucket answers its lower edge')
    assert.isNull(histQuantile([0, 0], [0, 1], 50))
  })
})

test.group('Quiz metrics: linking and units', () => {
  test("an attempt gets its learner's latest start of that quiz within 6 h", ({ assert }) => {
    const h = 3_600_000
    const match = deviceMatcher([
      { userId: 1, quizId: 7, at: 10 * h, device: 'web', appVersion: 'v1' },
      { userId: 1, quizId: 7, at: 12 * h, device: 'android', appVersion: 'v2' },
      { userId: 1, quizId: 8, at: 12 * h, device: 'ios', appVersion: null },
    ])
    assert.deepEqual(match(1, 7, 11 * h), { device: 'web', appVersion: 'v1' })
    assert.deepEqual(match(1, 7, 13 * h), { device: 'android', appVersion: 'v2' })
    assert.deepEqual(match(1, 7, 12 * h - 30_000), { device: 'android', appVersion: 'v2' }, 'a minute of clock skew')
    assert.isNull(match(1, 7, 9 * h), 'no start before it')
    assert.isNull(match(1, 7, 19 * h), 'the start is more than 6 h old')
    assert.isNull(match(2, 7, 11 * h))
    assert.isNull(match(1, 7, null))
  })

  test('speech usage converts to seconds; anything that is not time is ignored', ({ assert }) => {
    assert.equal(speechSeconds('seconds', 90), 90)
    assert.equal(speechSeconds('Minutes', 2), 120)
    assert.equal(speechSeconds('hour', 1), 3600)
    assert.isNull(speechSeconds('requests', 5))
  })
})

test.group('Quiz release log: seed list', () => {
  test('every seeded change is well formed and points at real metrics', ({ assert }) => {
    const titles = new Set<string>()
    for (const r of SEED_RELEASES) {
      assert.isFalse(titles.has(r.title), `duplicate title ${r.title}`)
      titles.add(r.title)
      assert.isAtMost(r.title.length, 160)
      assert.include(RELEASE_KINDS, r.kind)
      assert.include(RELEASE_SURFACES, r.surface)
      if (r.deployedAt) assert.isFalse(Number.isNaN(Date.parse(r.deployedAt)), r.title)
      for (const e of r.expects ?? []) {
        assert.isTrue(METRIC_BY_KEY.has(e.metric), `${r.title}: ${e.metric}`)
        assert.include(DIRECTIONS, e.direction)
      }
    }
  })
})
