import { test } from '@japa/runner'
import { orderedFunnel, type FunnelStep } from '#services/analytics/funnel'

const DAY = 86_400_000
const STEPS: FunnelStep[] = [
  { step: 'Opened the app', types: ['app_open'] },
  { step: 'Opened a lesson', types: ['lessons_open', 'pdf_open'] },
  { step: 'Started a quiz', types: ['quiz_start'] },
  { step: 'Finished a quiz', types: ['quiz_completed'] },
]
const ev = (userId: number, type: string, day: number) => ({ userId, type, at: day * DAY })
const users = (events: ReturnType<typeof ev>[], windowDays = 7) => orderedFunnel(events, STEPS, windowDays * DAY).map((s) => s.users)

test.group('Insights learning funnel: ordered and windowed (MUL-143)', () => {
  test('steps in order within the window count all the way', ({ assert }) => {
    assert.deepEqual(users([ev(1, 'app_open', 0), ev(1, 'pdf_open', 1), ev(1, 'quiz_start', 2), ev(1, 'quiz_completed', 2)]), [1, 1, 1, 1])
  })

  test('a later step done before an earlier one does not count', ({ assert }) => {
    // Finished a quiz, then opened the app and a lesson: the old funnel counted all four.
    assert.deepEqual(users([ev(1, 'quiz_start', 0), ev(1, 'quiz_completed', 0), ev(1, 'app_open', 1), ev(1, 'lessons_open', 2)]), [1, 1, 0, 0])
  })

  test('a step outside the window from the first step does not count', ({ assert }) => {
    assert.deepEqual(users([ev(1, 'app_open', 0), ev(1, 'pdf_open', 8)]), [1, 0, 0, 0])
    assert.deepEqual(users([ev(1, 'app_open', 0), ev(1, 'pdf_open', 8)], 10), [1, 1, 0, 0])
  })

  test('a later app open starts a new run, and the furthest run counts', ({ assert }) => {
    // Day 0 run stops at the lesson; the day 20 open leads to a quiz within 7 days.
    const events = [ev(1, 'app_open', 0), ev(1, 'pdf_open', 1), ev(1, 'app_open', 20), ev(1, 'lessons_open', 21), ev(1, 'quiz_start', 25)]
    assert.deepEqual(users(events), [1, 1, 1, 0])
  })

  test('the window runs from the latest start that reached the step', ({ assert }) => {
    // Opened day 0 and day 6; lesson day 7 and quiz day 12: only the day 6 run fits.
    const events = [ev(1, 'app_open', 0), ev(1, 'app_open', 6), ev(1, 'pdf_open', 7), ev(1, 'quiz_start', 12)]
    assert.deepEqual(users(events), [1, 1, 1, 0])
  })

  test('learners are counted separately, events of other types are ignored, unordered input is sorted', ({ assert }) => {
    const events = [
      ev(2, 'quiz_start', 3),
      ev(1, 'app_open', 0),
      ev(2, 'app_open', 1),
      ev(2, 'video_play', 2),
      ev(2, 'lessons_open', 2),
      ev(3, 'pdf_open', 1),
    ]
    assert.deepEqual(users(events), [2, 1, 1, 0])
  })

  test('steps at the same instant count in step order', ({ assert }) => {
    assert.deepEqual(users([ev(1, 'pdf_open', 0), ev(1, 'app_open', 0)]), [1, 1, 0, 0])
  })

  test('no events, no learners', ({ assert }) => {
    assert.deepEqual(orderedFunnel([], STEPS, DAY), STEPS.map((s) => ({ step: s.step, users: 0 })))
  })
})
