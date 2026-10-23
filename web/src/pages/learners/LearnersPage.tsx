import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api, type Paginated } from '../../lib/api'
import { fmtDateTime, fmtInt, fmtMinutes } from '../../lib/format'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { useAuth } from '../../lib/auth'
import { initials } from '../admin/StaffPage'
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
  const { can } = useAuth()
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
        subtitle={can('learners.pii.read') ? 'Search by learner id, the last 4+ digits of a phone number, a name or an email.' : 'Search by learner id, phone digits, name or email. Contact details are masked for your role.'}
      />
      <Card padded={false}>
        <form
          className="relative border-b border-border p-4"
          onSubmit={(e) => {
            e.preventDefault()
            setParams(q ? { q } : {})
          }}
        >
          <Search className="pointer-events-none absolute left-7 top-7 size-4 text-muted-foreground" aria-hidden />
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
                <tr key={l.id} className="border-b transition-colors hover:bg-muted/50">
                  <Td>
                    <Link to={`/learners/${l.id}`} className="flex items-center gap-3">
                      <Avatar className="size-8">
                        <AvatarFallback className="bg-accent text-xs font-semibold text-accent-foreground">{l.name ? initials(l.name) : '#'}</AvatarFallback>
                      </Avatar>
                      <span>
                        <span className="block font-medium hover:underline">{l.name ?? 'Unnamed'}</span>
                        <span className="block text-xs text-muted-foreground">#{l.id}</span>
                      </span>
                    </Link>
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
