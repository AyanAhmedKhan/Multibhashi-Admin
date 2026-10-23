import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api, type Paginated } from '../../lib/api'
import { fmtDateTime, fmtMinutes } from '../../lib/format'
import { Badge, Card, Empty, ErrorNote, Input, PageHeader, Pagination, Select, Spinner, Table, Td, type Tone } from '../../components/ui'

export interface ClassRow {
  id: number
  user_id: number
  status: string | null
  total_minutes: number | null
  remaining_minutes: number | null
  time_spent: number | null
  lesson_topic: string | null
  learner_name: string | null
  created_at: string
  updated_at: string | null
}

export function statusTone(status: string | null): Tone {
  switch (status) {
    case 'active':
      return 'green'
    case 'paused':
      return 'amber'
    case 'completed':
      return 'blue'
    default:
      return 'neutral'
  }
}

export function ClassesPage() {
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const page = Number(params.get('page') ?? 1)
  const filters = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    userId: params.get('userId') ?? '',
  }
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k))
    if (!('page' in patch)) next.delete('page')
    setParams(next)
  }
  const classes = useQuery({
    queryKey: ['classes', filters, page],
    queryFn: () => api.get<Paginated<ClassRow>>('tutor/classes', { ...filters, page, perPage: 25 }),
    placeholderData: keepPreviousData,
  })

  return (
    <>
      <PageHeader title="Classes" subtitle="Every AI tutor class. Learner names are masked unless your role can see personal data." />
      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <form
            className="relative min-w-[14rem] flex-1"
            onSubmit={(e) => {
              e.preventDefault()
              set({ q })
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-3 size-4 text-ink-3" aria-hidden />
            <Input aria-label="Search classes" className="pl-9" placeholder="Class id, lesson or room…" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <Select aria-label="Status" className="w-36" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
            <option value="pending">Pending</option>
          </Select>
          <Input aria-label="From date" type="date" className="w-40" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
          <Input aria-label="To date" type="date" className="w-40" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <ErrorNote error={classes.error} />
        {classes.isLoading ? (
          <Spinner />
        ) : !classes.data?.data.length ? (
          <Empty title="No classes match">Try a wider date range or clear the filters.</Empty>
        ) : (
          <>
            <Table head={['Class', 'Lesson', 'Learner', 'Status', 'Used / total', 'Started']}>
              {classes.data.data.map((c) => (
                <tr key={c.id} className="hover:bg-surface-2">
                  <Td>
                    <Link to={`/tutor/classes/${c.id}`} className="font-medium text-primary">
                      #{c.id}
                    </Link>
                  </Td>
                  <Td className="max-w-xs">{c.lesson_topic ?? '—'}</Td>
                  <Td>
                    <Link to={`/learners/${c.user_id}`} className="text-ink hover:text-primary">
                      {c.learner_name ?? `#${c.user_id}`}
                    </Link>
                    <div className="text-xs text-ink-3">#{c.user_id}</div>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(c.status)}>{c.status ?? 'unknown'}</Badge>
                  </Td>
                  <Td className="tabular whitespace-nowrap">
                    {fmtMinutes(c.time_spent)} / {fmtMinutes(c.total_minutes)}
                  </Td>
                  <Td className="whitespace-nowrap">{fmtDateTime(c.created_at)}</Td>
                </tr>
              ))}
            </Table>
            <Pagination page={classes.data.meta.currentPage} lastPage={classes.data.meta.lastPage} total={classes.data.meta.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>
    </>
  )
}
