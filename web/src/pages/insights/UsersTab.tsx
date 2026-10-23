import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtDay, fmtInt } from '../../lib/format'
import { Card, ErrorNote, Spinner, Stat } from '../../components/ui'
import { Bars, ChartCard, Line, shade, shadeInk } from '../../components/charts'
import { RankList } from '../OverviewPage'

interface UsersInsights {
  totals: {
    users: number
    signups: number
    signupsChange: number | null
    activeNow: number
    dau: number
    wau: number
    mau: number
    stickiness: number
    periodActive: number
    periodActiveChange: number | null
  }
  series: { day: string; activeUsers: number; sessions: number; appMinutes: number; signups: number }[]
  concurrency: { peaks: { day: string; peak: number; at: string | null }[]; today: { time: string; users: number }[]; truncated: boolean }
  devices: { device: string; users: number; sessions: number }[]
  appVersions: { version: string; users: number }[]
  heatmap: { weekday: number; hour: number; sessions: number }[]
  retention: { week: string; users: number; weeks: (number | null)[] }[]
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const time = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })

function change(v: number | null) {
  if (v === null) return 'new vs previous period'
  return `${v > 0 ? '+' : ''}${v}% vs previous period`
}

export function UsersTab({ days }: { days: number }) {
  const q = useQuery({ queryKey: ['insights-users', days], queryFn: () => api.get<UsersInsights>('insights/users', { days }) })
  if (q.isLoading) return <Spinner />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  const peak = Math.max(0, ...d.concurrency.peaks.map((p) => p.peak))
  const peakDay = d.concurrency.peaks.find((p) => p.peak === peak)
  const heatMax = Math.max(1, ...d.heatmap.map((h) => h.sessions))
  const cell = (w: number, h: number) => d.heatmap.find((x) => x.weekday === w && x.hour === h)?.sessions ?? 0

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Online now" value={fmtInt(d.totals.activeNow)} hint="app open, heartbeat < 90 s" />
        <Stat label="Active today (DAU)" value={fmtInt(d.totals.dau)} />
        <Stat label="Active, 7 days (WAU)" value={fmtInt(d.totals.wau)} />
        <Stat label="Active, 30 days (MAU)" value={fmtInt(d.totals.mau)} hint={`stickiness ${d.totals.stickiness}% (avg DAU ÷ MAU)`} />
        <Stat label={`Sign-ups, ${days} days`} value={fmtInt(d.totals.signups)} hint={change(d.totals.signupsChange)} />
        <Stat label="Registered learners" value={fmtInt(d.totals.users)} hint={`${fmtInt(d.totals.periodActive)} active in period (${change(d.totals.periodActiveChange)})`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Active learners per day"
          subtitle="Distinct learners who opened the app"
          rows={d.series}
          columns={[
            { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
            { key: 'activeUsers', label: 'Active learners' },
            { key: 'sessions', label: 'Sessions' },
            { key: 'appMinutes', label: 'App minutes' },
          ]}
        >
          <Line data={d.series} x="day" y="activeUsers" xFormat={fmtDay} label="active learners" />
        </ChartCard>
        <ChartCard
          title="Sign-ups per day"
          rows={d.series}
          columns={[
            { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
            { key: 'signups', label: 'Sign-ups' },
          ]}
        >
          <Bars data={d.series} x="day" y="signups" xFormat={fmtDay} label="sign-ups" />
        </ChartCard>
        <ChartCard
          title="Peak concurrent learners per day"
          subtitle={peakDay ? `Highest: ${fmtInt(peak)} on ${fmtDay(peakDay.day)}${peakDay.at ? ` at ${time.format(new Date(peakDay.at))}` : ''}. Size servers and LiveKit for this.` : undefined}
          rows={d.concurrency.peaks}
          columns={[
            { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
            { key: 'peak', label: 'Peak concurrent' },
            { key: 'at', label: 'At (IST)', format: (v) => (v ? time.format(new Date(String(v))) : '—') },
          ]}
        >
          <Bars data={d.concurrency.peaks} x="day" y="peak" xFormat={fmtDay} label="at the same time" />
        </ChartCard>
        <ChartCard
          title="Concurrent learners today"
          subtitle="Every 15 minutes, IST"
          rows={d.concurrency.today}
          columns={[
            { key: 'time', label: 'Time', format: (v) => time.format(new Date(String(v))) },
            { key: 'users', label: 'Online' },
          ]}
        >
          <Line data={d.concurrency.today} x="time" y="users" xFormat={(v) => time.format(new Date(v))} label="online" />
        </ChartCard>
      </div>

      <Card title="When learners study (app sessions started, IST)">
        <div className="overflow-x-auto">
          <table className="border-separate border-spacing-0.5 text-[11px]">
            <thead>
              <tr>
                <th />
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} className="w-7 font-normal text-muted-foreground">{h % 3 === 0 ? h : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEKDAYS.map((w, wi) => (
                <tr key={w}>
                  <th className="pr-2 text-left font-normal text-muted-foreground">{w}</th>
                  {Array.from({ length: 24 }, (_, h) => {
                    const v = cell(wi, h)
                    return (
                      <td
                        key={h}
                        title={`${w} ${h}:00–${h + 1}:00 · ${v} sessions`}
                        className="h-6 w-7 rounded-[3px]"
                        style={{ background: shade(v / heatMax) }}
                      />
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Darker = more sessions. Schedule live classes, campaigns and maintenance around this.</p>
      </Card>

      <Card title="Retention by sign-up week" padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Signed up (week of)</th>
                <th className="px-2 py-2 text-right font-medium">Learners</th>
                {Array.from({ length: 8 }, (_, k) => (
                  <th key={k} className="px-1 py-2 text-center font-medium">Week {k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.retention.map((r) => (
                <tr key={r.week} className="border-b border-border">
                  <td className="whitespace-nowrap px-4 py-1.5">{fmtDay(r.week)}</td>
                  <td className="tabular px-2 text-right">{fmtInt(r.users)}</td>
                  {r.weeks.map((v, k) => (
                    <td key={k} className="px-0.5 py-0.5">
                      {v === null ? null : (
                        <div className="tabular rounded px-1 py-1 text-center text-xs" style={{ background: shade(v / 100), color: shadeInk(v / 100) }}>
                          {v}%
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-muted-foreground">Share of each sign-up week who opened the app again N weeks later. Week 0 is the sign-up week.</p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Devices">
          <RankList rows={d.devices.map((x) => ({ label: x.device, value: x.users }))} unit="learners" />
        </Card>
        <Card title="App versions in use">
          <RankList rows={d.appVersions.map((x) => ({ label: x.version, value: x.users }))} unit="learners" />
          <p className="mt-3 text-xs text-muted-foreground">Old versions still in use decide how long an API change must stay backwards compatible.</p>
        </Card>
      </div>
      {d.concurrency.truncated && <p className="text-xs text-warning">Concurrency was computed on the first 300,000 sessions of the period.</p>}
    </div>
  )
}
