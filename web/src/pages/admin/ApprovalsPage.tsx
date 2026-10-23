import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtAgo, fmtDateTime } from '../../lib/format'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Spinner, Tabs, type Tone } from '../../components/ui'

interface Approval {
  id: number
  action: string
  summary: string
  status: string
  requestedBy: { id: number; name: string; email: string } | null
  requestReason: string
  decidedBy: { id: number; name: string } | null
  decidedAt: string | null
  decisionNote: string | null
  error: string | null
  expiresAt: string
  createdAt: string
  requiredPermissions: string[]
  requiredRole: string | null
}

const TONE: Record<string, Tone> = { pending: 'amber', approved: 'green', rejected: 'red', failed: 'red', cancelled: 'neutral', expired: 'neutral' }
const ACTION_LABEL: Record<string, string> = {
  'tutor.minutes.grant': 'Big minutes grant',
  'tutor.access.grant': 'AI Pro without payment',
  'console.roles.assign': 'New Super Admin',
}

export function ApprovalsPage() {
  const { me, can, refresh } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'pending' | 'all'>('pending')
  const list = useQuery({
    queryKey: ['approvals', tab],
    queryFn: () => api.get<Approval[]>('approvals', { status: tab === 'pending' ? 'pending' : undefined }),
  })
  const decider = can('console.approvals.decide')

  const decide = (a: Approval, approve: boolean) =>
    ask({
      title: approve ? 'Approve and run' : 'Reject request',
      description: (
        <>
          <b>{a.summary}</b>
          <br />
          Requested by {a.requestedBy?.name}: “{a.requestReason}”
        </>
      ),
      confirmLabel: approve ? 'Approve' : 'Reject',
      danger: !approve,
      run: async (note) => {
        await api.post(`approvals/${a.id}/decide`, { decision: approve ? 'approve' : 'reject', note })
        toast.success(approve ? 'Approved and done' : 'Request rejected')
        await queryClient.invalidateQueries({ queryKey: ['approvals'] })
        await refresh()
      },
    })

  const cancel = async (a: Approval) => {
    await api.post(`approvals/${a.id}/cancel`)
    await queryClient.invalidateQueries({ queryKey: ['approvals'] })
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle={
          decider
            ? 'Four-eyes control: big grants, complimentary AI Pro and new Super Admins wait here. You can’t approve your own requests.'
            : 'Requests you raised that wait for a second person.'
        }
      />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'pending', label: 'Waiting' }, { value: 'all', label: 'History' }]} />
      <ErrorNote error={list.error} />
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.length ? (
        <Card>
          <Empty title={tab === 'pending' ? 'Nothing waiting' : 'No requests yet'}>Requests appear here when an action needs a second approver.</Empty>
        </Card>
      ) : (
        <div className="space-y-3">
          {list.data.map((a) => {
            const mine = a.requestedBy?.id === me?.user.id
            const allowed = decider && !mine && a.requiredPermissions.some((p) => can(p)) && (!a.requiredRole || me?.roles.some((r) => r.slug === a.requiredRole))
            return (
              <Card key={a.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={TONE[a.status] ?? 'neutral'}>{a.status}</Badge>
                      <Badge tone="violet">{ACTION_LABEL[a.action] ?? a.action}</Badge>
                      <span className="text-xs text-muted-foreground">#{a.id} · {fmtAgo(a.createdAt)}</span>
                    </div>
                    <p className="font-medium text-foreground">{a.summary}</p>
                    <p className="text-sm text-ink-2">
                      {a.requestedBy?.name ?? 'Someone'} ({a.requestedBy?.email}): “{a.requestReason}”
                    </p>
                    {a.decidedBy && (
                      <p className="text-sm text-muted-foreground">
                        {a.status} by {a.decidedBy.name} {fmtDateTime(a.decidedAt)}: “{a.decisionNote}”
                      </p>
                    )}
                    {a.error && <p className="text-sm text-danger">Failed: {a.error}</p>}
                    {a.status === 'pending' && <p className="text-xs text-muted-foreground">Expires {fmtDateTime(a.expiresAt)}</p>}
                  </div>
                  {a.status === 'pending' && (
                    <div className="flex gap-2">
                      {allowed && (
                        <>
                          <Button size="sm" variant="primary" icon={<Check className="size-4" />} onClick={() => decide(a, true)}>Approve</Button>
                          <Button size="sm" icon={<X className="size-4" />} onClick={() => decide(a, false)}>Reject</Button>
                        </>
                      )}
                      {mine && <Button size="sm" variant="ghost" onClick={() => cancel(a)}>Cancel request</Button>}
                    </div>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}
