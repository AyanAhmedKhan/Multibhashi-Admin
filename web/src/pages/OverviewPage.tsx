import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, BadgeCheck, CalendarRange, Gift, Radio, Sparkles, Timer } from 'lucide-react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDay, fmtInt, fmtMinutes } from '../lib/format'
import { Card, ErrorNote, PageHeader, Spinner, Stat } from '../components/ui'
import { Bars, ChartCard } from '../components/charts'

export interface TutorOverview {
  today: { classes: number; learners: number; minutes: number }
  week: { classes: number; learners: number; minutes: number }
  statuses: { status: string; total: number }[]
  freeGrantsToday: { grants: number; minutes: number }
  consoleGrantsWeek: { grants: number; minutes: number }
  topTopics: { topic: string; total: number }[]
  series: { day: string; classes: number; learners: number; minutes: number }[]
}

/** Ranked horizontal bars in HTML: value at the tip, text in ink tokens, mark in the chart hue. */
export function RankList({ rows, unit }: { rows: { label: string; value: number }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing yet in this period.</p>
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex justify-between gap-3 text-sm">
            <span className="truncate text-ink-2">{r.label}</span>
            <span className="tabular shrink-0 font-medium">
              {fmtInt(r.value)}
              {unit ? <span className="font-normal text-muted-foreground"> {unit}</span> : null}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div className="h-2 rounded-full bg-chart" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export function OverviewPage() {
  const { me, can } = useAuth()
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api.get<TutorOverview>('overview', undefined, { background: true }), refetchInterval: 60_000 })
  const live = useQuery({
    queryKey: ['live'],
    queryFn: () => api.get<unknown[]>('tutor/live', undefined, { background: true }),
    enabled: can('tutor.live.read'),
    refetchInterval: 15_000,
  })
  const d = overview.data

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${me?.user.name.split(' ')[0]}`}
        subtitle="AI tutor activity across MultiBhashi, in IST. Other modules join this page as they move into the console."
      />
      <ErrorNote error={overview.error} />
      {overview.isLoading && <Spinner rows={6} />}
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat
              label="Live now"
              icon={<Radio />}
              value={live.data ? fmtInt(live.data.length) : '—'}
              hint={can('tutor.live.read') ? <Link className="text-primary hover:underline" to="/tutor/live">Open live classes</Link> : 'No access'}
            />
            <Stat label="Classes today" icon={<Sparkles />} value={fmtInt(d.today.classes)} hint={`${fmtInt(d.today.learners)} learners`} />
            <Stat label="Minutes today" icon={<Timer />} value={fmtInt(d.today.minutes)} hint="taught by the AI tutor" />
            <Stat label="Classes, 7 days" icon={<CalendarRange />} value={fmtInt(d.week.classes)} hint={`${fmtInt(d.week.learners)} learners`} />
            <Stat label="Free grants today" icon={<Gift />} value={fmtInt(d.freeGrantsToday.grants)} hint={`${fmtMinutes(d.freeGrantsToday.minutes)} granted`} />
            <Stat
              label="Pending approvals"
              icon={<BadgeCheck />}
              value={fmtInt(me?.pendingApprovals ?? 0)}
              tone={(me?.pendingApprovals ?? 0) > 0 ? 'amber' : undefined}
              hint={<Link className="text-primary hover:underline" to="/approvals">Review</Link>}
            />
          </div>
          <ChartCard
            title="Classes per day"
            subtitle="Last 14 days, IST"
            rows={d.series}
            columns={[
              { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
              { key: 'classes', label: 'Classes' },
              { key: 'learners', label: 'Learners' },
              { key: 'minutes', label: 'Minutes used' },
            ]}
          >
            <Bars data={d.series} x="day" y="classes" xFormat={fmtDay} label="classes" height={260} />
          </ChartCard>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Most taught lessons" description="Last 7 days">
              <RankList rows={d.topTopics.map((t) => ({ label: t.topic, value: t.total }))} unit="classes" />
            </Card>
            <Card title="How classes ended" description="Last 7 days">
              <RankList rows={d.statuses.map((s) => ({ label: s.status, value: s.total }))} unit="classes" />
              <p className="mt-4 text-xs text-muted-foreground">
                Console grants this week: {fmtInt(d.consoleGrantsWeek.grants)} ({fmtMinutes(d.consoleGrantsWeek.minutes)}).
              </p>
            </Card>
          </div>
          {can('analytics.read') && (
            <Link to="/insights/users" className="group flex items-center justify-between rounded-xl border bg-card px-5 py-4 text-sm transition-colors hover:bg-muted/50">
              <span>
                <span className="font-medium">Users, concurrency, screens and AI cost</span>
                <span className="block text-muted-foreground">Open Insights for trends, retention and unit economics.</span>
              </span>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          )}
        </div>
      )}
    </>
  )
}
