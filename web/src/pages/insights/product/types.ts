/** Responses of /api/insights/product/* (api/app/services/product_analytics/insights.ts). */

export interface DayRange {
  from: string
  to: string
  prevFrom: string
  prevTo: string
  days: number
}

export type NotConnected = { connected: false; missing: string[]; problem: string | null; location: string }
export type NotReady = { connected: true; ready: false; message: string }
export type Ready<T> = { connected: true; ready: true; range: DayRange } & T
export type Answer<T> = NotConnected | NotReady | Ready<T>

export interface Freshness {
  source: string
  at: string | null
  hours: number | null
  stale: boolean
}

export interface Overview {
  totals: {
    dau: number
    wau: number
    mau: number
    stickiness: number
    periodActive: number
    prevActive: number
    periodActiveChange: number | null
    sessions: number
    prevSessions: number
    sessionsChange: number | null
    avgSessionMinutes: number
    newVerified: number
    prevVerified: number
    newVerifiedChange: number | null
    activation: { cohort: number; activated: number; rate: number | null; bySignup: number }
  }
  series: { day: string; activeLearners: number; visitors: number; sessions: number; minutes: number; signups: number }[]
  weekly: { week: string; activeLearners: number; sessions: number; signups: number }[]
  platforms: { platform: string; people: number; sessions: number }[]
}

export interface ScreenRow {
  screen: string
  views: number
  prevViews: number
  viewsChange: number | null
  users: number
  medianSeconds: number | null
  exits: number
  exitRate: number | null
  into: { screen: string; views: number }[]
  outOf: { screen: string; views: number }[]
}

export interface Features {
  wau: number
  features: {
    key: string
    label: string
    users: number
    prevUsers: number
    usersChange: number | null
    users7d: number
    adoption: number | null
    uses: number
    usesPerUser: number
    series: { day: string; users: number }[]
  }[]
  retention: { feature: string; label: string; week1: Cell; week2: Cell; week4: Cell }[]
}
type Cell = { cohort: number; rate: number | null } | null

export interface FunnelStep {
  label: string
  users: number
  medianGapSeconds: number | null
  fromPrevious: number | null
  fromFirst: number | null
  dropped: number
}

export interface Funnels {
  funnels: {
    key: string
    label: string
    windowDays: number
    steps: FunnelStep[]
    conversion: number | null
    conversionBefore: number | null
    startedBefore: number
    previous: number[]
  }[]
  breakdown: string | null
  segments: { segment: string; steps: number[]; conversion: number | null }[]
}

export interface Dropoffs {
  funnel: string
  step: number
  stoppedAfter: string
  nextStep: string
  total: number
  byPlatform: { value: string; people: number }[]
  byVersion: { value: string; people: number }[]
  byChannel: { value: string; people: number }[]
  learners: { tdUserId: number | null; signedIn: boolean; platform: string | null; appVersion: string | null; channel: string | null; startDate: string; lastStepAt: string | null }[] | null
}

export interface Retention {
  filter: { basis?: string; channel?: string; feature?: string }
  cohorts: { week: string; users: number; weeks: (number | null)[] }[]
  channels: { value: string; people: number }[]
  features: { value: string; people: number }[]
  bases: { value: string; people: number }[]
}

export interface Health {
  errorsDaily: { day: string; events: number }[]
  errorsByType: { type: string; events: number; screens: number }[]
  errorsByScreen: { screen: string; events: number }[]
  errorsByVersion: { appVersion: string; platform: string; events: number }[]
  slowApis: { endpoint: string; events: number; p50: number | null; p95: number | null }[]
  vitals: { name: string; events: number; p75: number | null; poorShare: number | null }[]
  slowScreens: { screen: string; appVersion: string; events: number; p75: number | null; poorShare: number | null }[]
  freshness: Freshness[]
}
