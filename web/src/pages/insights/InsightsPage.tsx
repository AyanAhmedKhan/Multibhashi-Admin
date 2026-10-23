import type { ReactNode } from 'react'
import { NavLink, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { cx, PageHeader, Select } from '../../components/ui'
import { UsersTab } from './UsersTab'
import { EngagementTab } from './EngagementTab'
import { TutorTab } from './TutorTab'
import { CostTab } from './CostTab'

export function useDays() {
  const [params, setParams] = useSearchParams()
  const days = Number(params.get('days') ?? 30)
  return [days, (d: number) => setParams({ days: String(d) })] as const
}

function Highlights() {
  const highlights = useQuery({
    queryKey: ['insights-highlights'],
    queryFn: () => api.get<{ tone: 'up' | 'down' | 'flat' | 'warn'; text: string }[]>('insights/highlights'),
  })
  if (!highlights.data?.length) return null
  return (
    <ul className="mb-6 grid gap-2 md:grid-cols-2">
      {highlights.data.map((h, i) => (
        <li key={i} className="flex items-start gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-ink-2 shadow-xs">
          {h.tone === 'up' ? (
            <TrendingUp className="mt-0.5 size-4 shrink-0 text-success" aria-label="up" />
          ) : h.tone === 'down' ? (
            <TrendingDown className="mt-0.5 size-4 shrink-0 text-danger" aria-label="down" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="attention" />
          )}
          {h.text}
        </li>
      ))}
    </ul>
  )
}

export function InsightsPage() {
  const { tab = 'users' } = useParams()
  const { can } = useAuth()
  const [days, setDays] = useDays()
  const tabs: { key: string; label: string; show: boolean; node: ReactNode }[] = [
    { key: 'users', label: 'Users & growth', show: true, node: <UsersTab days={days} /> },
    { key: 'engagement', label: 'Screens & content', show: true, node: <EngagementTab days={days} /> },
    { key: 'ai', label: 'AI tutor usage', show: true, node: <TutorTab days={days} /> },
    { key: 'cost', label: 'Cost & margin', show: can('analytics.cost.read'), node: <CostTab days={days} /> },
  ]
  const current = tabs.find((t) => t.key === tab && t.show) ?? tabs[0]
  return (
    <>
      <PageHeader
        title="Insights"
        subtitle="Aggregates across all learners (no personal data). IST days. Data from the app’s activity tracking and the AI tutor."
        actions={
          <Select aria-label="Period" className="w-40" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
        }
      />
      <Highlights />
      <div className="mb-6 inline-flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <NavLink
              key={t.key}
              to={`/insights/${t.key}?days=${days}`}
              className={cx(
                'whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                current.key === t.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t.label}
            </NavLink>
          ))}
      </div>
      {current.node}
    </>
  )
}
