import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDay, fmtInt, fmtMinutes } from '../lib/format'
import { Button, Card, ErrorNote, PageHeader, Spinner, Stat, Table, Td } from '../components/ui'

export interface TutorOverview {
  today: { classes: number; learners: number; minutes: number }
  week: { classes: number; learners: number; minutes: number }
  statuses: { status: string; total: number }[]
  freeGrantsToday: { grants: number; minutes: number }
  consoleGrantsWeek: { grants: number; minutes: number }
  topTopics: { topic: string; total: number }[]
  series: { day: string; classes: number; learners: number; minutes: number }[]
}

/** Ranked horizontal bars in HTML: value at the tip, text in ink tokens, mark in the chart color. */
export function RankList({ rows, unit }: { rows: { label: string; value: number }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (!rows.length) return <p className="text-sm text-ink-3">Nothing yet in this period.</p>
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex justify-between gap-3 text-sm">
            <span className="truncate text-ink-2">{r.label}</span>
            <span className="tabular shrink-0 font-medium text-ink">
              {fmtInt(r.value)}
              {unit ? ` ${unit}` : ''}
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface-2">
            <div className="h-2 rounded-full bg-chart" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function DailyClassesChart({ series }: { series: TutorOverview['series'] }) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card
      title="Classes per day (last 14 days, IST)"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'Show table'}
        </Button>
      }
    >
      {asTable ? (
        <Table head={['Day', 'Classes', 'Learners', 'Minutes used']}>
          {series.map((d) => (
            <tr key={d.day}>
              <Td>{fmtDay(d.day)}</Td>
              <Td className="tabular">{fmtInt(d.classes)}</Td>
              <Td className="tabular">{fmtInt(d.learners)}</Td>
              <Td className="tabular">{fmtInt(d.minutes)}</Td>
            </tr>
          ))}
        </Table>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis
                dataKey="day"
                tickFormatter={fmtDay}
                tick={{ fill: 'var(--ink-3)', fontSize: 12 }}
                axisLine={{ stroke: 'var(--chart-grid)' }}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={16}
              />
              <YAxis allowDecimals={false} tick={{ fill: 'var(--ink-3)', fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={{ fill: 'var(--surface-2)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload as TutorOverview['series'][number]
                  return (
                    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md">
                      <div className="font-medium text-ink">{fmtDay(d.day)}</div>
                      <div className="tabular mt-1 text-ink-2">{fmtInt(d.classes)} classes · {fmtInt(d.learners)} learners</div>
                      <div className="tabular text-ink-3">{fmtMinutes(d.minutes)} used</div>
                    </div>
                  )
                }}
              />
              <Bar dataKey="classes" fill="var(--chart)" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

export function OverviewPage() {
  const { me, can } = useAuth()
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api.get<TutorOverview>('overview'), refetchInterval: 60_000 })
  const live = useQuery({
    queryKey: ['live'],
    queryFn: () => api.get<unknown[]>('tutor/live', undefined, { background: true }),
    enabled: can('tutor.live.read'),
    refetchInterval: 15_000,
  })

  return (
    <>
      <PageHeader
        title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${me?.user.name.split(' ')[0]}`}
        subtitle="AI tutor activity across MultiBhashi. Times are IST. Other modules join this page as they move into the console."
      />
      <ErrorNote error={overview.error} />
      {overview.isLoading && <Spinner />}
      {overview.data && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Live now" value={live.data ? fmtInt(live.data.length) : '—'} hint={can('tutor.live.read') ? <Link className="text-primary" to="/tutor/live">Open live classes</Link> : 'No access'} />
            <Stat label="Classes today" value={fmtInt(overview.data.today.classes)} hint={`${fmtInt(overview.data.today.learners)} learners`} />
            <Stat label="Minutes used today" value={fmtInt(overview.data.today.minutes)} />
            <Stat label="Classes, 7 days" value={fmtInt(overview.data.week.classes)} hint={`${fmtInt(overview.data.week.learners)} learners`} />
            <Stat label="Free grants today" value={fmtInt(overview.data.freeGrantsToday.grants)} hint={`${fmtMinutes(overview.data.freeGrantsToday.minutes)} granted`} />
            <Stat
              label="Pending approvals"
              value={fmtInt(me?.pendingApprovals ?? 0)}
              tone={(me?.pendingApprovals ?? 0) > 0 ? 'amber' : undefined}
              hint={<Link className="text-primary" to="/approvals">Review</Link>}
            />
          </div>
          <DailyClassesChart series={overview.data.series} />
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Most taught lessons (7 days)">
              <RankList rows={overview.data.topTopics.map((t) => ({ label: t.topic, value: t.total }))} unit="classes" />
            </Card>
            <Card title="How classes ended (7 days)">
              <RankList rows={overview.data.statuses.map((s) => ({ label: s.status, value: s.total }))} unit="classes" />
              <p className="mt-4 text-xs text-ink-3">
                Console grants this week: {fmtInt(overview.data.consoleGrantsWeek.grants)} ({fmtMinutes(overview.data.consoleGrantsWeek.minutes)}).
              </p>
            </Card>
          </div>
        </div>
      )}
    </>
  )
}
