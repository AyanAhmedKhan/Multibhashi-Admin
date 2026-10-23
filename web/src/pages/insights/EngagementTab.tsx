import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtDay, fmtInt, fmtMinutes } from '../../lib/format'
import { Badge, Card, ErrorNote, Spinner, Table, Td } from '../../components/ui'
import { ChartCard, Line } from '../../components/charts'
import { RankList } from '../OverviewPage'

interface Engagement {
  screens: { screen: string; visits: number; users: number; engagedMinutes: number; avgEngagedMinutes: number; idleShare: number; timeouts: number }[]
  topContent: { screen: string; resourceType: string | null; resourceId: string; visits: number; users: number; engagedMinutes: number }[]
  events: { event: string; total: number; users: number }[]
  engagedSeries: { day: string; learners: number; minutesPerLearner: number }[]
  funnel: { step: string; users: number }[]
  freshness: { lastRollupDay: string | null; stuckSegments: number }
}

const SCREEN_LABEL: Record<string, string> = {
  pdf: 'PDF lesson',
  quiz: 'Quiz',
  quiz_feedback: 'Quiz feedback',
  video: 'Class recording',
  learn_card_video: 'Learn-card video',
  lesson: 'Lesson list',
  ai_tutor: 'AI tutor',
}

export function EngagementTab({ days }: { days: number }) {
  const q = useQuery({ queryKey: ['insights-engagement', days], queryFn: () => api.get<Engagement>('insights/engagement', { days }) })
  if (q.isLoading) return <Spinner />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  const top = d.funnel[0]?.users || 1

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Most used screens (visits)">
          <RankList rows={d.screens.map((s) => ({ label: SCREEN_LABEL[s.screen] ?? s.screen, value: s.visits }))} unit="visits" />
        </Card>
        <Card title="Learning funnel" padded>
          <ul className="space-y-3">
            {d.funnel.map((f, i) => (
              <li key={f.step}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="text-ink-2">{i + 1}. {f.step}</span>
                  <span className="tabular font-medium">
                    {fmtInt(f.users)} <span className="font-normal text-ink-3">({Math.round((f.users / top) * 100)}%)</span>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-surface-2">
                  <div className="h-2 rounded-full bg-chart" style={{ width: `${(f.users / top) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-3">Learners in the period who did each step and every step before it. The biggest drop is where to improve the app first.</p>
        </Card>
      </div>

      <Card title="Screens in detail" padded={false}>
        <Table head={['Screen', 'Visits', 'Learners', 'Engaged time', 'Per visit', 'Idle share', 'Idle timeouts']}>
          {d.screens.map((s) => (
            <tr key={s.screen}>
              <Td className="font-medium">{SCREEN_LABEL[s.screen] ?? s.screen}</Td>
              <Td className="tabular">{fmtInt(s.visits)}</Td>
              <Td className="tabular">{fmtInt(s.users)}</Td>
              <Td className="tabular">{fmtMinutes(s.engagedMinutes)}</Td>
              <Td className="tabular">{s.avgEngagedMinutes} min</Td>
              <Td className="tabular">{s.idleShare >= 30 ? <Badge tone="amber">{s.idleShare}%</Badge> : `${s.idleShare}%`}</Td>
              <Td className="tabular">{fmtInt(s.timeouts)}</Td>
            </tr>
          ))}
        </Table>
        <p className="px-4 py-3 text-xs text-ink-3">Engaged time excludes idle time (no touch or scroll past the screen’s threshold). A high idle share means learners leave the screen open without using it.</p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Engaged minutes per learner per day"
          rows={d.engagedSeries}
          columns={[
            { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
            { key: 'learners', label: 'Learners' },
            { key: 'minutesPerLearner', label: 'Minutes / learner' },
          ]}
        >
          <Line data={d.engagedSeries} x="day" y="minutesPerLearner" xFormat={fmtDay} yFormat={(v) => String(v)} label="min per learner" />
        </ChartCard>
        <Card title="Events">
          <RankList rows={d.events.slice(0, 10).map((e) => ({ label: e.event.replace(/_/g, ' '), value: e.total }))} />
        </Card>
      </div>

      <Card title="Most opened content" padded={false}>
        <Table head={['Screen', 'Content', 'Visits', 'Learners', 'Engaged time']}>
          {d.topContent.map((c, i) => (
            <tr key={i}>
              <Td>{SCREEN_LABEL[c.screen] ?? c.screen}</Td>
              <Td>
                {c.resourceType ?? 'item'} #{c.resourceId}
              </Td>
              <Td className="tabular">{fmtInt(c.visits)}</Td>
              <Td className="tabular">{fmtInt(c.users)}</Td>
              <Td className="tabular">{fmtMinutes(c.engagedMinutes)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Data health">
        <ul className="space-y-1 text-sm text-ink-2">
          <li>
            Daily rollup (02:00 IST cron) last ran for: <b>{d.freshness.lastRollupDay ?? 'never'}</b>
          </li>
          <li>
            Screen visits stuck open for more than 15 min: <b>{fmtInt(d.freshness.stuckSegments)}</b>
            {d.freshness.stuckSegments > 50 && <Badge tone="amber">check the sweeper cron</Badge>}
          </li>
        </ul>
      </Card>
    </div>
  )
}
