import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api, type Paginated } from '../../lib/api'
import { fmtDateTime, fmtInt, fmtMinutes } from '../../lib/format'
import { Card, Empty, ErrorNote, Input, PageHeader, Pagination, Spinner, Table, Td } from '../../components/ui'

interface LearnerRow {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  createdAt: string | null
  classes: number
  minutesUsed: number
  lastClassAt: string | null
}

export function LearnersPage() {
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const page = Number(params.get('page') ?? 1)
  const term = params.get('q') ?? ''
  const learners = useQuery({
    queryKey: ['learners', term, page],
    queryFn: () => api.get<Paginated<LearnerRow>>('learners', { q: term, page, perPage: 25 }),
    placeholderData: keepPreviousData,
  })

  return (
    <>
      <PageHeader
        title="Learners"
        subtitle="Search by learner id, the last 4+ digits of a phone number, a name or an email. Contact details stay masked until you reveal them (audited)."
      />
      <Card padded={false}>
        <form
          className="relative border-b border-line p-4"
          onSubmit={(e) => {
            e.preventDefault()
            setParams(q ? { q } : {})
          }}
        >
          <Search className="pointer-events-none absolute left-7 top-7 size-4 text-ink-3" aria-hidden />
          <Input aria-label="Search learners" className="pl-9" placeholder="e.g. 5023, 43210, Priya, priya@…" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <ErrorNote error={learners.error} />
        {learners.isLoading ? (
          <Spinner />
        ) : !learners.data?.data.length ? (
          <Empty title={term ? 'No learner matches' : 'No recent AI tutor learners'}>{term ? 'Check the number or try a name.' : 'Search for anyone above.'}</Empty>
        ) : (
          <>
            <Table head={['Learner', 'Phone', 'Email', 'AI classes', 'Minutes used', 'Last class', 'Joined']}>
              {learners.data.data.map((l) => (
                <tr key={l.id} className="hover:bg-surface-2">
                  <Td>
                    <Link to={`/learners/${l.id}`} className="font-medium text-primary">
                      {l.name ?? 'Unnamed'}
                    </Link>
                    <div className="text-xs text-ink-3">#{l.id}</div>
                  </Td>
                  <Td className="tabular">{l.phone ?? '—'}</Td>
                  <Td>{l.email ?? '—'}</Td>
                  <Td className="tabular">{fmtInt(l.classes)}</Td>
                  <Td className="tabular">{fmtMinutes(l.minutesUsed)}</Td>
                  <Td className="whitespace-nowrap">{fmtDateTime(l.lastClassAt)}</Td>
                  <Td className="whitespace-nowrap">{fmtDateTime(l.createdAt)}</Td>
                </tr>
              ))}
            </Table>
            <Pagination
              page={learners.data.meta.currentPage}
              lastPage={learners.data.meta.lastPage}
              total={learners.data.meta.total}
              onPage={(p) => setParams({ ...(term ? { q: term } : {}), page: String(p) })}
            />
          </>
        )}
      </Card>
    </>
  )
}
