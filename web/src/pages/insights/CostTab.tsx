import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Pencil, Plus, Receipt } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtDay, fmtInt, fmtMinutes, fmtQuantity, inr } from '../../lib/format'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Select, Spinner, Stat, Table, Td } from '../../components/ui'
import { Bars, ChartCard } from '../../components/charts'

type Engine = 'sarvam' | 'global' | 'gemini'
export interface PriceLine {
  id: string
  label: string
  provider: string
  model: string
  unit: string
  price: number
  currency: 'INR' | 'USD'
  per: number
  /** First IST day (YYYY-MM-DD) the price applies; absent = since always. */
  from?: string
  source?: string
  note?: string
}
export interface CostModel {
  v: 2
  basedOn?: string
  usdToInr: number
  pricePerPaidMinuteInr: number
  defaultEngine: Engine
  prices: PriceLine[]
  assumptions: Record<Engine, { label: string; usage: { priceId: string; perMinute: number }[] }>
  fixedMonthly: { label: string; amountInr: number }[]
  checkedOn: string
}
interface ProviderLine {
  id: string
  label: string
  provider: string
  model: string
  unit: string
  unitLabel: string
  quantity: number
  exactInr: number
  estimatedInr: number
  totalInr: number
  priced: boolean
}
interface CostInsights {
  recorded: boolean
  classes: number
  minutes: number
  coverage: { classes: number; minutes: number; minutesShare: number }
  exactInr: number
  estimatedInr: number
  fixedInr: number
  totalInr: number
  perMinuteInr: number
  exactPerMinuteInr: number | null
  perClassInr: number
  perLearnerInr: number
  perClass: { avg: number | null; median: number; p90: number }
  soldMinutes: number
  revenueInr: number
  marginShare: number | null
  monthlyRunRateInr: number
  byProvider: ProviderLine[]
  engines: { engine: Engine; label: string; classes: number; minutes: number; exactInr: number; estimatedInr: number; measuredPerMinuteInr: number | null; assumedPerMinuteInr: number }[]
  topClasses: { id: number; userId: number; topic: string | null; engine: string; minutes: number; costInr: number }[]
  calibration: { engine: Engine; priceId: string; label: string; unit: string; assumed: number; measured: number; basisMinutes: number }[]
  series: { day: string; exactInr: number; estimatedInr: number; costInr: number }[]
  model: CostModel
  modelStatus: { basedOn: string | null; latestCheckedOn: string; outdated: boolean }
  latestModel: CostModel | null
}
interface ReconRow {
  month: string
  provider: string
  exactInr: number
  estimatedInr: number
  computedInr: number
  billedInr: number | null
  note: string | null
  variancePct: number | null
}

const PROVIDER_NAME: Record<string, string> = { sarvam: 'Sarvam', google: 'Google Gemini', livekit: 'LiveKit', other: 'Other' }

export function CostTab({ days }: { days: number }) {
  const { can } = useAuth()
  const q = useQuery({ queryKey: ['insights-cost', days], queryFn: () => api.get<CostInsights>('insights/cost', { days }) })
  const recon = useQuery({ queryKey: ['insights-recon'], queryFn: () => api.get<ReconRow[]>('insights/reconciliation') })
  const [editing, setEditing] = useState<'prices' | 'assumptions' | null>(null)
  const [addPrice, setAddPrice] = useState<Partial<PriceLine> | null>(null)
  const [bill, setBill] = useState<{ month: string; provider: string } | null>(null)
  const ask = useReason()
  const queryClient = useQueryClient()
  if (q.isLoading) return <Spinner />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  const manage = can('analytics.costs.manage')
  const unpriced = d.byProvider.filter((p) => !p.priced)
  const sarvam = d.byProvider.filter((p) => p.provider === 'sarvam')

  const saveModel = (model: CostModel, title: string) =>
    ask({
      title,
      description: 'Changes every cost figure in Insights. The before/after cost per minute is audited.',
      confirmLabel: 'Save',
      run: async (reason) => {
        await api.put('insights/cost-model', { model: { ...model, checkedOn: new Date().toISOString().slice(0, 10) }, reason })
        await queryClient.invalidateQueries({ queryKey: ['insights-cost'] })
        await queryClient.invalidateQueries({ queryKey: ['insights-recon'] })
        setEditing(null)
        setAddPrice(null)
      },
    })

  const adoptMeasured = () => {
    const next = structuredClone(d.model)
    for (const c of d.calibration) {
      const usage = next.assumptions[c.engine].usage
      const found = usage.find((u) => u.priceId === c.priceId)
      if (found) found.perMinute = c.measured
      else usage.push({ priceId: c.priceId, perMinute: c.measured })
    }
    saveModel(next, 'Use measured usage for estimates')
  }

  return (
    <div className="space-y-6">
      {!d.recorded ? (
        <div className="rounded-lg border border-border bg-warning-soft px-3 py-2 text-sm text-warning">
          <b>Estimate.</b> Per-class usage recording isn’t live yet (the tutor API’s <code>ai_tutor_session_usage</code> table). Until it is, cost = minutes ×
          the per-minute assumptions below.
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-success-soft px-3 py-2 text-sm text-success">
          <b>Exact for {d.coverage.minutesShare}% of minutes</b> ({fmtInt(d.coverage.classes)} of {fmtInt(d.classes)} classes): recorded usage × the price list.
          {d.coverage.minutesShare < 100 && ' The rest (classes without a usage record) is estimated and labelled.'}
        </div>
      )}
      {d.modelStatus.outdated && d.latestModel && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-warning-soft px-3 py-2 text-sm text-warning">
          <span>
            <b>Newer official prices.</b> Sarvam, Google and LiveKit prices and the USD rate were re-checked on {fmtDay(d.modelStatus.latestCheckedOn)}; the saved price list
            {d.modelStatus.basedOn ? ` is from ${fmtDay(d.modelStatus.basedOn)}` : ' predates that'}. Your own lines, estimates and fixed costs stay as they are.
          </span>
          {manage && (
            <Button size="sm" variant="primary" onClick={() => saveModel(d.latestModel!, 'Use the latest official prices')}>
              Use latest prices
            </Button>
          )}
        </div>
      )}
      {unpriced.length > 0 && (
        <div className="rounded-lg border border-border bg-danger-soft px-3 py-2 text-sm text-danger">
          Usage without a price: {unpriced.map((u) => `${u.provider} ${u.model} ${u.unitLabel}`).join(', ')}. It counts as ₹0 until a price is added below.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label={`AI cost, ${days} days`} value={inr(d.totalInr)} hint={`${inr(d.exactInr)} exact · ${inr(d.estimatedInr)} estimated`} />
        <Stat label="Cost per minute taught" value={inr(d.perMinuteInr, 2)} hint={d.exactPerMinuteInr !== null ? `exact classes: ${inr(d.exactPerMinuteInr, 2)}` : 'break-even price'} />
        <Stat label="Cost per class" value={inr(d.perClassInr, 1)} hint={d.perClass.avg !== null ? `median ${inr(d.perClass.median, 1)} · p90 ${inr(d.perClass.p90, 1)}` : `${fmtInt(d.classes)} classes`} />
        <Stat label="Cost per learner" value={inr(d.perLearnerInr, 1)} />
        <Stat label="Revenue (minutes sold)" value={inr(d.revenueInr)} hint={`${fmtInt(d.soldMinutes)} min × ${inr(d.model.pricePerPaidMinuteInr, 2)}`} />
        <Stat
          label="Margin on sold minutes"
          value={d.marginShare === null ? '—' : `${d.marginShare}%`}
          tone={d.marginShare !== null && d.marginShare < 20 ? 'red' : undefined}
          hint={`run-rate ${inr(d.monthlyRunRateInr)}/month`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Sarvam (speech in, speech out)">
          {sarvam.length ? (
            <ul className="space-y-3">
              {sarvam.map((s) => (
                <li key={s.id}>
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="text-ink-2">{s.label}</span>
                    <span className="tabular font-semibold">{inr(s.totalInr)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.quantity ? fmtQuantity(s.quantity, s.unit) : 'no recorded usage'}
                    {s.estimatedInr > 0 && ` · ${inr(s.estimatedInr)} estimated`}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No Sarvam usage in this period.</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">STT is billed per audio second streamed; Bulbul TTS per character spoken.</p>
        </Card>
        <Card title="By engine" className="lg:col-span-2" padded={false}>
          <Table head={['Engine', 'Classes', 'Minutes', 'Cost', '₹/min measured', '₹/min assumed']}>
            {d.engines.map((e) => (
              <tr key={e.engine}>
                <Td>{e.label}</Td>
                <Td className="tabular">{fmtInt(e.classes)}</Td>
                <Td className="tabular">{fmtInt(e.minutes)}</Td>
                <Td className="tabular">{inr(e.exactInr + e.estimatedInr)}</Td>
                <Td className="tabular">{e.measuredPerMinuteInr === null ? '—' : inr(e.measuredPerMinuteInr, 2)}</Td>
                <Td className="tabular text-muted-foreground">{inr(e.assumedPerMinuteInr, 2)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Cost by provider and service" padded={false}>
        <Table head={['Service', 'Provider', 'Usage', 'Exact', 'Estimated', 'Total', 'Share']}>
          {d.byProvider.map((p) => (
            <tr key={p.id} className={p.priced ? '' : 'bg-danger-soft'}>
              <Td>
                {p.label}
                <div className="text-xs text-muted-foreground">{p.model && p.model !== '*' ? p.model : 'any model'} · {p.unitLabel}</div>
              </Td>
              <Td>{PROVIDER_NAME[p.provider] ?? p.provider}</Td>
              <Td className="tabular whitespace-nowrap">{p.quantity ? fmtQuantity(p.quantity, p.unit) : '—'}</Td>
              <Td className="tabular">{inr(p.exactInr)}</Td>
              <Td className="tabular text-muted-foreground">{inr(p.estimatedInr)}</Td>
              <Td className="tabular font-medium">{inr(p.totalInr)}</Td>
              <Td className="tabular">
                {p.priced ? (
                  d.totalInr ? `${Math.round((p.totalInr / d.totalInr) * 1000) / 10}%` : '—'
                ) : manage ? (
                  <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAddPrice({ provider: p.provider, model: p.model, unit: p.unit, currency: 'USD', per: 1_000_000, price: 0, label: p.label })}>
                    Add price
                  </Button>
                ) : (
                  <Badge tone="red">unpriced</Badge>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <ChartCard
        title="AI cost per day"
        subtitle="Exact + estimated"
        rows={d.series}
        columns={[
          { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
          { key: 'exactInr', label: 'Exact', format: (v) => inr(Number(v), 2) },
          { key: 'estimatedInr', label: 'Estimated', format: (v) => inr(Number(v), 2) },
          { key: 'costInr', label: 'Total', format: (v) => inr(Number(v), 2) },
        ]}
      >
        <Bars data={d.series} x="day" y="costInr" xFormat={fmtDay} yFormat={(v) => inr(v)} label="" />
      </ChartCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Most expensive classes" padded={false}>
          {d.topClasses.length ? (
            <Table head={['Class', 'Engine', 'Minutes', 'Cost', '₹/min']}>
              {d.topClasses.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link className="font-medium text-primary" to={`/tutor/classes/${c.id}`}>#{c.id}</Link>
                    <div className="max-w-48 truncate text-xs text-muted-foreground">{c.topic ?? '—'}</div>
                  </Td>
                  <Td>{c.engine}</Td>
                  <Td className="tabular">{fmtMinutes(c.minutes)}</Td>
                  <Td className="tabular">{inr(c.costInr, 2)}</Td>
                  <Td className="tabular">{c.minutes ? inr(c.costInr / c.minutes, 2) : '—'}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">Shown once classes report usage.</p>
          )}
        </Card>
        <Card
          title="Calibration: usage per class minute"
          padded={false}
          actions={manage && d.calibration.length > 0 && <Button size="sm" onClick={adoptMeasured}>Use measured</Button>}
        >
          {d.calibration.length ? (
            <Table head={['Engine', 'Service', 'Assumed', 'Measured']}>
              {d.calibration.map((c) => {
                const off = c.assumed ? Math.abs(c.measured - c.assumed) / c.assumed : 1
                return (
                  <tr key={`${c.engine}-${c.priceId}`}>
                    <Td>{c.engine}</Td>
                    <Td>{c.label}</Td>
                    <Td className="tabular">{fmtInt(c.assumed)}</Td>
                    <Td className="tabular">{off > 0.25 ? <Badge tone="amber">{fmtInt(c.measured)}</Badge> : fmtInt(c.measured)}</Td>
                  </tr>
                )
              })}
            </Table>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">Once classes report usage, the measured values appear here; adopt them so estimates for older classes match reality.</p>
          )}
        </Card>
      </div>

      <Card
        title={<span className="inline-flex items-center gap-2"><Receipt className="size-4" aria-hidden /> Reconcile with the bills</span>}
        padded={false}
      >
        <Table head={['Month', 'Provider', 'Computed', 'Of which estimated', 'Billed', 'Difference', '']}>
          {(recon.data ?? []).map((r) => (
            <tr key={`${r.month}-${r.provider}`}>
              <Td className="whitespace-nowrap">{r.month}</Td>
              <Td>{PROVIDER_NAME[r.provider] ?? r.provider}</Td>
              <Td className="tabular">{inr(r.computedInr)}</Td>
              <Td className="tabular text-muted-foreground">{inr(r.estimatedInr)}</Td>
              <Td className="tabular">{inr(r.billedInr)}</Td>
              <Td className="tabular">
                {r.variancePct === null ? '—' : Math.abs(r.variancePct) > 15 ? <Badge tone="amber">{r.variancePct > 0 ? '+' : ''}{r.variancePct}%</Badge> : `${r.variancePct > 0 ? '+' : ''}${r.variancePct}%`}
              </Td>
              <Td>{manage && <Button size="sm" variant="ghost" onClick={() => setBill({ month: r.month, provider: r.provider })}>{r.billedInr === null ? 'Enter bill' : 'Edit'}</Button>}</Td>
            </tr>
          ))}
        </Table>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Sarvam has no usage API (one credit balance per organisation), so enter each month’s charge from its Billing page, and Google/LiveKit from their invoices. A gap over 15% usually means a usage figure or price needs updating.
        </p>
      </Card>

      <Card
        title="Price list"
        padded={false}
        actions={manage && (
          <>
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAddPrice({ currency: 'USD', per: 1_000_000, price: 0, model: '*' })}>Add</Button>
            <Button size="sm" icon={<Pencil className="size-4" />} onClick={() => setEditing('prices')}>Edit</Button>
          </>
        )}
      >
        <Table head={['Service', 'Provider · model · unit', 'Price', 'Source']}>
          {d.model.prices.map((p) => (
            <tr key={p.id}>
              <Td>
                {p.label}
                {p.from && <Badge tone="blue">from {fmtDay(p.from)}</Badge>}
                {p.note && <div className="max-w-sm text-xs text-muted-foreground">{p.note}</div>}
              </Td>
              <Td className="text-xs text-ink-2">{p.provider} · {p.model === '*' ? 'any model' : p.model} · {p.unit}</Td>
              <Td className="tabular whitespace-nowrap">{p.currency === 'USD' ? '$' : '₹'}{p.price} / {fmtInt(p.per)}</Td>
              <Td>{p.source ? <a className="inline-flex items-center gap-1 text-primary" href={p.source} target="_blank" rel="noreferrer noopener">pricing <ExternalLink className="size-3" aria-hidden /></a> : '—'}</Td>
            </tr>
          ))}
        </Table>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          USD → INR {d.model.usdToInr} · learner price {inr(d.model.pricePerPaidMinuteInr, 2)}/min · fixed monthly {d.model.fixedMonthly.map((f) => `${f.label} ${inr(f.amountInr)}`).join(', ')} · checked {d.model.checkedOn}
          {manage && <> · <button className="text-primary" onClick={() => setEditing('assumptions')}>edit estimates & fixed costs</button></>}
        </p>
      </Card>

      {editing && <ModelEditor mode={editing} model={d.model} onClose={() => setEditing(null)} onSave={(m) => saveModel(m, editing === 'prices' ? 'Save price list' : 'Save estimates')} />}
      {addPrice && (
        <AddPrice
          draft={addPrice}
          onClose={() => setAddPrice(null)}
          onSave={(line) => saveModel({ ...d.model, prices: [...d.model.prices, line] }, `Add price: ${line.label}`)}
        />
      )}
      {bill && (
        <BillDialog
          {...bill}
          onClose={() => setBill(null)}
          onSave={(amount, note) =>
            ask({
              title: `Bill for ${PROVIDER_NAME[bill.provider]} ${bill.month}`,
              confirmLabel: 'Save',
              run: async (reason) => {
                await api.put('insights/invoices', { month: bill.month, provider: bill.provider, amount_inr: amount, note: note || undefined, reason })
                await queryClient.invalidateQueries({ queryKey: ['insights-recon'] })
                setBill(null)
              },
            })
          }
        />
      )}
    </div>
  )
}

function AddPrice({ draft, onClose, onSave }: { draft: Partial<PriceLine>; onClose: () => void; onSave: (line: PriceLine) => void }) {
  const [line, setLine] = useState<Partial<PriceLine>>(draft)
  const set = (patch: Partial<PriceLine>) => setLine({ ...line, ...patch })
  const valid = line.label && line.provider && line.unit && line.model !== undefined && (line.per ?? 0) > 0 && (line.price ?? -1) >= 0
  return (
    <Modal
      open
      title="Add a price"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() =>
              onSave({
                id: `${line.provider}-${line.unit}-${Date.now().toString(36)}`.replace(/[^a-z0-9_.:-]/g, '-'),
                label: line.label!,
                provider: line.provider!,
                model: line.model ?? '*',
                unit: line.unit!,
                price: Number(line.price),
                currency: line.currency ?? 'USD',
                per: Number(line.per),
                ...(line.from ? { from: line.from } : {}),
              })
            }
          >
            Continue
          </Button>
        </>
      }
    >
      <Field label="Name">{(id) => <Input id={id} value={line.label ?? ''} onChange={(e) => set({ label: e.target.value })} />}</Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Provider">{(id) => <Input id={id} value={line.provider ?? ''} onChange={(e) => set({ provider: e.target.value.toLowerCase() })} />}</Field>
        <Field label="Model (* = any)">{(id) => <Input id={id} value={line.model ?? ''} onChange={(e) => set({ model: e.target.value })} />}</Field>
        <Field label="Unit">{(id) => <Input id={id} value={line.unit ?? ''} onChange={(e) => set({ unit: e.target.value })} />}</Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Price">{(id) => <Input id={id} type="number" step="any" value={line.price ?? 0} onChange={(e) => set({ price: Number(e.target.value) })} />}</Field>
        <Field label="Currency">
          {(id) => (
            <Select id={id} value={line.currency ?? 'USD'} onChange={(e) => set({ currency: e.target.value as 'INR' | 'USD' })}>
              <option>USD</option>
              <option>INR</option>
            </Select>
          )}
        </Field>
        <Field label="Per (units)">{(id) => <Input id={id} type="number" value={line.per ?? 1} onChange={(e) => set({ per: Number(e.target.value) })} />}</Field>
      </div>
      <Field label="Applies from (optional)" hint="For a price change: classes before this day keep the current price. Leave empty for a new service.">
        {(id) => <Input id={id} type="date" value={line.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} />}
      </Field>
    </Modal>
  )
}

function BillDialog({ month, provider, onClose, onSave }: { month: string; provider: string; onClose: () => void; onSave: (amount: number, note: string) => void }) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  return (
    <Modal open title={`Bill: ${PROVIDER_NAME[provider] ?? provider}, ${month}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!(Number(amount) >= 0) || amount === ''} onClick={() => onSave(Number(amount), note)}>Continue</Button></>}>
      <Field label="Amount charged (₹, incl. GST as invoiced)">{(id) => <Input id={id} type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
      <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. invoice INV-1042, credits used from dashboard" />}</Field>
    </Modal>
  )
}

function ModelEditor({ mode, model, onClose, onSave }: { mode: 'prices' | 'assumptions'; model: CostModel; onClose: () => void; onSave: (m: CostModel) => void }) {
  const [draft, setDraft] = useState<CostModel>(() => structuredClone(model))
  const update = (fn: (m: CostModel) => void) => {
    const next = structuredClone(draft)
    fn(next)
    setDraft(next)
  }
  return (
    <Modal open wide title={mode === 'prices' ? 'Edit the price list' : 'Edit estimates and fixed costs'} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSave(draft)}>Save</Button></>}>
      {mode === 'prices' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="USD → INR">{(id) => <Input id={id} type="number" step="0.01" value={draft.usdToInr} onChange={(e) => update((m) => (m.usdToInr = Number(e.target.value)))} />}</Field>
            <Field label="Learner price per paid minute (₹)">{(id) => <Input id={id} type="number" step="0.01" value={draft.pricePerPaidMinuteInr} onChange={(e) => update((m) => (m.pricePerPaidMinuteInr = Number(e.target.value)))} />}</Field>
          </div>
          <div className="space-y-2">
            {draft.prices.map((p, i) => (
              <div key={p.id} className="grid items-end gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1fr_6rem_6rem_auto]">
                <div className="text-sm">
                  {p.label}
                  <div className="text-xs text-muted-foreground">{p.provider} · {p.model} · {p.unit} · {p.currency}{p.from ? ` · from ${p.from}` : ''}</div>
                </div>
                <Field label="Price">{(id) => <Input id={id} type="number" step="any" value={p.price} onChange={(e) => update((m) => (m.prices[i].price = Number(e.target.value)))} />}</Field>
                <Field label="Per">{(id) => <Input id={id} type="number" value={p.per} onChange={(e) => update((m) => (m.prices[i].per = Number(e.target.value)))} />}</Field>
                <Button size="sm" variant="ghost" disabled={Object.values(draft.assumptions).some((a) => a.usage.some((u) => u.priceId === p.id))} title="Used by an estimate" onClick={() => update((m) => m.prices.splice(i, 1))}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <Field label="Engine when a class’s language is unknown">
            {(id) => (
              <Select id={id} value={draft.defaultEngine} onChange={(e) => update((m) => (m.defaultEngine = e.target.value as Engine))}>
                <option value="sarvam">sarvam</option>
                <option value="global">global</option>
                <option value="gemini">gemini</option>
              </Select>
            )}
          </Field>
          {(Object.keys(draft.assumptions) as Engine[]).map((engine) => (
            <div key={engine}>
              <div className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{draft.assumptions[engine].label}: usage per class minute</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {draft.assumptions[engine].usage.map((u, i) => {
                  const line = draft.prices.find((p) => p.id === u.priceId)
                  return (
                    <Field key={u.priceId} label={`${line?.label ?? u.priceId} (${line?.unit ?? ''})`}>
                      {(id) => <Input id={id} type="number" step="any" value={u.perMinute} onChange={(e) => update((m) => (m.assumptions[engine].usage[i].perMinute = Number(e.target.value)))} />}
                    </Field>
                  )
                })}
              </div>
            </div>
          ))}
          <div className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fixed monthly (₹)</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {draft.fixedMonthly.map((f, i) => (
              <Field key={i} label={f.label}>
                {(id) => <Input id={id} type="number" value={f.amountInr} onChange={(e) => update((m) => (m.fixedMonthly[i].amountInr = Number(e.target.value)))} />}
              </Field>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
