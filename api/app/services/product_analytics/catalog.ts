/**
 * What the models count, in one place (DESIGN §6–7; event and prop names from the app's
 * analytics/tracking-plan.yaml). Changing a definition changes the models from the next run;
 * re-run `analytics:models --from … --to …` to rebuild history with it.
 */

export interface FeatureDef {
  key: string
  label: string
  /** Any of these events is a use. */
  events?: string[]
  /** Or a screen_viewed of one of these screens. */
  screens?: string[]
}

/** Feature adoption (m_feature_daily). '_active' (everyone with an event) is added by the model. */
export const FEATURES: FeatureDef[] = [
  { key: 'ai_tutor', label: 'AI tutor class', events: ['tutor_session_started'] },
  { key: 'live_class', label: 'Live class joined', events: ['join_opened'] },
  { key: 'quiz', label: 'Quiz started', events: ['quiz_started'] },
  { key: 'notes', label: 'Notes opened', events: ['notes_opened'] },
  { key: 'recordings', label: 'Recording played', events: ['recording_played'] },
  { key: 'study_material', label: 'Study material', events: ['study_material_opened'] },
  { key: 'chat', label: 'Chat', screens: ['Chats', 'Chat'] },
  { key: 'plans', label: 'Plans viewed', events: ['plans_viewed'] },
]

export const ACTIVE = '_active'

/** "First value" (activation, DESIGN §7): a tutor class started, a class joined or a quiz started. */
export const VALUE_EVENTS = ['tutor_session_started', 'join_opened', 'quiz_started']

/** Dwell-time histogram buckets, in seconds: [0,5), [5,10), … [600,1800]. Dwell is capped at 1800. */
export const DWELL_EDGES = [0, 5, 10, 20, 30, 60, 120, 300, 600, 1800]
export const DWELL_CAP_S = 1800

/** Health events (MUL-154): essential, so they arrive even from learners who opted out. */
export const HEALTH_EVENTS = ['app_error', 'api_slow', 'web_vital']

export interface StepDef {
  label: string
  /** App events: any of these names (optionally with a condition on its props). */
  events?: string[]
  /** A BigQuery condition on the event row `e` (e.props is JSON), ANDed with the name. */
  where?: string
  /** A server step from the facts (joined to the app's user_id through identities). */
  server?: 'payment_captured' | 'booking_created'
}

export interface FunnelDef {
  key: string
  label: string
  /** A step counts only within this many days of the run's start. */
  windowDays: number
  /** A prop that scopes a run (e.g. the class type): steps must share it. */
  scopeProp?: string
  steps: StepDef[]
}

export const FUNNELS: FunnelDef[] = [
  {
    key: 'signup',
    label: 'Sign-up → first value',
    windowDays: 7,
    steps: [
      { label: 'Landing viewed', events: ['landing_viewed'] },
      { label: 'Phone or username submitted', events: ['auth_identifier_submitted'] },
      { label: 'OTP requested', events: ['otp_requested'] },
      { label: 'OTP verified', events: ['otp_verified'] },
      { label: 'Sign-up completed', events: ['signup_completed'] },
      { label: 'First value (tutor, class or quiz)', events: VALUE_EVENTS },
    ],
  },
  {
    key: 'ai_tutor',
    label: 'AI tutor',
    windowDays: 1,
    steps: [
      { label: 'Tutor entry viewed', events: ['tutor_entry_viewed'] },
      { label: 'Language selected', events: ['tutor_language_selected'] },
      { label: 'Lesson opened', events: ['tutor_lesson_opened'] },
      { label: 'Class started', events: ['tutor_session_started'] },
      { label: 'Tutor heard (first turn)', events: ['tutor_first_turn'] },
      { label: 'Class of 5+ minutes', events: ['tutor_session_ended'], where: "SAFE_CAST(JSON_VALUE(e.props, '$.minutes') AS FLOAT64) >= 5" },
    ],
  },
  {
    // DESIGN: "same class". The events carry the class type but no class id, so a run is
    // scoped to the class type, within a day (the next-class card shows one class at a time).
    key: 'live_class',
    label: 'Live class',
    windowDays: 1,
    scopeProp: 'class_type',
    steps: [
      { label: 'Next class viewed', events: ['next_class_viewed'] },
      { label: 'Join tapped', events: ['join_clicked'] },
      { label: 'Class opened', events: ['join_opened'] },
    ],
  },
  {
    key: 'quiz',
    label: 'Quiz',
    windowDays: 1,
    steps: [
      { label: 'Quiz opened', events: ['quiz_opened'] },
      { label: 'Quiz started', events: ['quiz_started'] },
      // q_index is 0-based in the tracking plan: the first question.
      { label: 'First question answered', events: ['quiz_question_answered'], where: "SAFE_CAST(JSON_VALUE(e.props, '$.q_index') AS INT64) = 0" },
      { label: 'Quiz completed', events: ['quiz_completed'] },
    ],
  },
  {
    key: 'purchase',
    label: 'Purchase',
    windowDays: 3,
    steps: [
      { label: 'Plans viewed', events: ['plans_viewed'] },
      { label: 'Plan selected', events: ['plan_selected'] },
      { label: 'Checkout opened', events: ['checkout_opened'] },
      { label: 'Payment captured (server)', server: 'payment_captured' },
      { label: 'Booking created (server)', server: 'booking_created' },
    ],
  },
]

export const FUNNEL_BY_KEY = new Map(FUNNELS.map((f) => [f.key, f]))

/** The longest funnel window: how many start days a nightly run recomputes (plus a day). */
export const MAX_WINDOW_DAYS = Math.max(...FUNNELS.map((f) => f.windowDays))

const quote = (s: string) => `'${s.replace(/[^A-Za-z0-9_ .\-]/g, '')}'`
export const sqlList = (items: string[]) => items.map(quote).join(', ')

/**
 * SQL: the feature of an event row (`event_name`, and `screen_name` for screen_viewed), or NULL.
 * Used on a CTE that exposes those two columns.
 */
export function featureCase() {
  const whens = FEATURES.map((f) => {
    const conds: string[] = []
    if (f.events?.length) conds.push(`event_name IN (${sqlList(f.events)})`)
    if (f.screens?.length) conds.push(`(event_name = 'screen_viewed' AND screen_name IN (${sqlList(f.screens)}))`)
    return `WHEN ${conds.join(' OR ')} THEN ${quote(f.key)}`
  })
  return `CASE\n      ${whens.join('\n      ')}\n    END`
}

/** Every app event name a funnel reads. */
export function funnelEvents(f: FunnelDef) {
  return [...new Set(f.steps.flatMap((s) => s.events ?? []))]
}
