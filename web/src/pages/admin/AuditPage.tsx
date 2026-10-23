import { Fragment, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { api, type Paginated } from '../../lib/api'
import { fmtDateTime, humanAction } from '../../lib/format'
import { Badge, Button, Card, ErrorNote, Input, PageHeader, Pagination, Select, Spinner, Table, Td } from '../../components/ui'

interface AuditRow {
  id: number
  created_at: string
  actor_id: number | null
  actor_email: string | null
  action: string
  target_type: string | null
  target_id: string | null
  outcome: 'success' | 'denied' | 'failure'
  reason: string | null
  metadata: Record<string, unknown> | null
  ip: string | null
}

export function AuditPage() {
  const [filters, setFilters] = useState({ q: '', action: '', outcome: '', from: '', to: '' })
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<number | null>(null)
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAt?: number } | null>(null)
  const [verifying, setVerifying] = useState(false)
  const log = useQuery({
    queryKey: ['audit', filters, page],
    queryFn: () => api.get<Paginated<AuditRow>>('audit', { ...filters, page, perPage: 50 }),
    placeholderData: keepPreviousData,
  })
  const set = (patch: Partial<typeof filters>) => {
    setFilters({ ...filters, ...patch })
    setPage(1)
  }
  const runVerify = async () => {
    setVerifying(true)
    try {
      setVerify(await api.post('audit/verify'))
    } finally {
      setVerifying(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every change, every sensitive read and every refused attempt, with who, when, from where and why. Append-only and hash-chained: editing or deleting a row breaks the chain."
        actions={
          <Button icon={<ShieldCheck className="size-4" />} loading={verifying} onClick={runVerify}>
            Verify integrity
          </Button>
        }
      />
      {verify && (
        <div className={`mb-4 rounded-lg border border-line px-3 py-2 text-sm ${verify.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
          {verify.ok ? `Chain intact: ${verify.checked.toLocaleString('en-IN')} entries verified.` : `Chain broken at entry #${verify.brokenAt}: the log was altered. Escalate to the Super Admins.`}
        </div>
      )}
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-line p-4">
          <Input aria-label="Search" className="min-w-[12rem] flex-1" placeholder="Email, reason or target id…" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
          <Select aria-label="Action" className="w-48" value={filters.action} onChange={(e) => set({ action: e.target.value })}>
            <option value="">Any action</option>
            <option value="auth.">Sign-ins</option>
            <option value="staff.">Staff changes</option>
            <option value="roles.">Role changes</option>
            <option value="approval.">Approvals</option>
            <option value="tutor.minutes">Minutes</option>
            <option value="tutor.access">AI Pro</option>
            <option value="tutor.transcript">Transcripts read</option>
            <option value="tutor.memory">Memory</option>
            <option value="learners.">Learner data</option>
            <option value="settings.">Settings</option>
            <option value="access.denied">Refused</option>
          </Select>
          <Select aria-label="Outcome" className="w-36" value={filters.outcome} onChange={(e) => set({ outcome: e.target.value })}>
            <option value="">Any outcome</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="failure">Failure</option>
          </Select>
          <Input aria-label="From" type="date" className="w-40" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
          <Input aria-label="To" type="date" className="w-40" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <ErrorNote error={log.error} />
        {log.isLoading ? (
          <Spinner />
        ) : (
          <>
            <Table head={['When', 'Who', 'What', 'Target', 'Why', '']}>
              {(log.data?.data ?? []).map((r) => (
                <Fragment key={r.id}>
                  <tr className="hover:bg-surface-2">
                    <Td className="whitespace-nowrap text-ink-2">{fmtDateTime(r.created_at)}</Td>
                    <Td>
                      <div className="max-w-[14rem] truncate">{r.actor_email ?? 'system'}</div>
                      <div className="text-xs text-ink-3">{r.ip}</div>
                    </Td>
                    <Td>
                      <div>{humanAction(r.action)}</div>
                      {r.outcome !== 'success' && <Badge tone={r.outcome === 'denied' ? 'amber' : 'red'}>{r.outcome}</Badge>}
                    </Td>
                    <Td className="whitespace-nowrap">{r.target_type ? `${r.target_type} #${r.target_id}` : '—'}</Td>
                    <Td className="max-w-xs text-ink-2">{r.reason ?? '—'}</Td>
                    <Td>
                      {r.metadata && (
                        <Button size="sm" variant="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                          {open === r.id ? 'Hide' : 'Details'}
                        </Button>
                      )}
                    </Td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={6} className="bg-surface-2 px-4 py-3">
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-ink-2">{JSON.stringify(r.metadata, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Table>
            {log.data && <Pagination page={log.data.meta.currentPage} lastPage={log.data.meta.lastPage} total={log.data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  )
}
