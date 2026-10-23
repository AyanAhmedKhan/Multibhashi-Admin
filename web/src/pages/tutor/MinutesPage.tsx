import { useState } from 'react'
import { Link } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, type Paginated } from '../../lib/api'
import { fmtDateTime } from '../../lib/format'
import { Badge, Card, ErrorNote, PageHeader, Pagination, Select, Spinner, Table, Tabs, Td } from '../../components/ui'

interface LedgerRow {
  id: number
  user_id: number
  quiz_question_id: number | null
  ai_tutor_chat_id: number | null
  source: string | null
  minutes_added: number
  new_total: number
  created_at: string
  lesson_topic: string | null
}

interface GrantRow {
  id: number
  user_id: number
  ai_tutor_chat_id: number
  source: string
  minutes: number
  created_at: string
}

const SOURCE_HELP: Record<string, string> = {
  free: 'free class',
  single_purchase: 'bought one lesson',
  extend: 'bought an extension',
  manual_grant: 'granted with the CLI',
  console_grant: 'added in the console',
  console_deduct: 'removed in the console',
  console_ai_pro: 'AI Pro given in the console',
  console_ai_pro_end: 'AI Pro ended: unused minutes taken back',
}

export function MinutesPage() {
  const [tab, setTab] = useState<'ledger' | 'free'>('ledger')
  const [source, setSource] = useState('')
  const [page, setPage] = useState(1)
  const ledger = useQuery({
    queryKey: ['ledger', source, page],
    queryFn: () => api.get<Paginated<LedgerRow> & { sources: string[] }>('tutor/minutes', { source, page }),
    enabled: tab === 'ledger',
    placeholderData: keepPreviousData,
  })
  const free = useQuery({
    queryKey: ['free-grants', page],
    queryFn: () => api.get<Paginated<GrantRow> & { topLast24h: { userId: number; grants: number }[] }>('tutor/free-grants', { page }),
    enabled: tab === 'free',
    placeholderData: keepPreviousData,
  })

  return (
    <>
      <PageHeader
        title="Minutes ledger"
        subtitle="Every minute a learner received: purchases, free classes, and grants by staff. The class total is the sum of its lesson’s rows."
      />
      <Tabs
        value={tab}
        onChange={(v) => {
          setTab(v)
          setPage(1)
        }}
        items={[
          { value: 'ledger', label: 'All minutes' },
          { value: 'free', label: 'Free & fallback grants' },
        ]}
      />
      {tab === 'ledger' ? (
        <Card
          padded={false}
          actions={
            <Select aria-label="Source" className="w-48" value={source} onChange={(e) => (setSource(e.target.value), setPage(1))}>
              <option value="">Every source</option>
              {(ledger.data?.sources ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          }
          title="Ledger"
        >
          <ErrorNote error={ledger.error} />
          {ledger.isLoading ? (
            <Spinner />
          ) : (
            <>
              <Table head={['When', 'Learner', 'Lesson', 'Source', 'Added', 'Total after']}>
                {(ledger.data?.data ?? []).map((l) => (
                  <tr key={l.id}>
                    <Td className="whitespace-nowrap">{fmtDateTime(l.created_at)}</Td>
                    <Td>
                      <Link className="text-primary" to={`/learners/${l.user_id}`}>#{l.user_id}</Link>
                    </Td>
                    <Td>
                      {l.ai_tutor_chat_id ? <Link className="text-primary" to={`/tutor/classes/${l.ai_tutor_chat_id}`}>{l.lesson_topic ?? `class #${l.ai_tutor_chat_id}`}</Link> : '—'}
                    </Td>
                    <Td>
                      <Badge tone={l.source?.startsWith('console_') || l.source === 'manual_grant' ? 'violet' : l.source === 'free' ? 'green' : 'blue'}>{l.source ?? '—'}</Badge>
                      {l.source && SOURCE_HELP[l.source] && <div className="mt-0.5 text-xs text-muted-foreground">{SOURCE_HELP[l.source]}</div>}
                    </Td>
                    <Td className="tabular">{l.minutes_added > 0 ? '+' : ''}{l.minutes_added}</Td>
                    <Td className="tabular">{l.new_total}</Td>
                  </tr>
                ))}
              </Table>
              {ledger.data && <Pagination page={ledger.data.meta.currentPage} lastPage={ledger.data.meta.lastPage} total={ledger.data.meta.total} onPage={setPage} />}
            </>
          )}
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Grants without a purchase" padded={false} className="lg:col-span-2">
            <ErrorNote error={free.error} />
            {free.isLoading ? (
              <Spinner />
            ) : (
              <>
                <Table head={['When', 'Learner', 'Class', 'Kind', 'Minutes']}>
                  {(free.data?.data ?? []).map((g) => (
                    <tr key={g.id}>
                      <Td className="whitespace-nowrap">{fmtDateTime(g.created_at)}</Td>
                      <Td><Link className="text-primary" to={`/learners/${g.user_id}`}>#{g.user_id}</Link></Td>
                      <Td><Link className="text-primary" to={`/tutor/classes/${g.ai_tutor_chat_id}`}>#{g.ai_tutor_chat_id}</Link></Td>
                      <Td><Badge tone={g.source === 'free' ? 'green' : 'amber'}>{g.source}</Badge></Td>
                      <Td className="tabular">{g.minutes}</Td>
                    </tr>
                  ))}
                </Table>
                {free.data && <Pagination page={free.data.meta.currentPage} lastPage={free.data.meta.lastPage} total={free.data.meta.total} onPage={setPage} />}
              </>
            )}
          </Card>
          <Card title="Most grants, last 24 h">
            <p className="mb-3 text-xs text-muted-foreground">A learner at the daily cap many days running may be farming free classes.</p>
            <ul className="space-y-2 text-sm">
              {(free.data?.topLast24h ?? []).map((t) => (
                <li key={t.userId} className="flex justify-between">
                  <Link className="text-primary" to={`/learners/${t.userId}`}>Learner #{t.userId}</Link>
                  <span className="tabular font-medium">{t.grants}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  )
}
