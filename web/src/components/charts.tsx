import { useState, type ReactNode } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Button, Card, Table, Td } from './ui'

/**
 * Charts on shadcn's ChartContainer (Recharts). Dataviz rules: one validated hue
 * (--chart-1, checked against both card surfaces), one axis, bars ≤ 24 px with a 4 px
 * rounded data end, 2 px lines with a 10 % wash, hairline grid, a tooltip on every
 * chart, and a table view for every chart.
 */

export interface Column<T> {
  key: keyof T & string
  label: string
  format?: (v: T[keyof T], row: T) => ReactNode
}

export function ChartCard<T extends object>({
  title,
  subtitle,
  rows,
  columns,
  children,
  className,
}: {
  title: string
  subtitle?: ReactNode
  rows: T[]
  columns: Column<T>[]
  children: ReactNode
  className?: string
}) {
  const [table, setTable] = useState(false)
  return (
    <Card
      className={className}
      title={title}
      description={subtitle}
      actions={
        <Button size="sm" variant="ghost" onClick={() => setTable((v) => !v)}>
          {table ? 'Chart' : 'Table'}
        </Button>
      }
    >
      {table ? (
        <div className="-m-5 max-h-80 overflow-y-auto">
          <Table head={columns.map((c) => c.label)}>
            {rows.map((row, i) => (
              <tr key={i} className="border-b">
                {columns.map((c) => (
                  <Td key={c.key} className="tabular">
                    {c.format ? c.format(row[c.key], row) : String(row[c.key] ?? '—')}
                  </Td>
                ))}
              </tr>
            ))}
          </Table>
        </div>
      ) : (
        children
      )}
    </Card>
  )
}

interface SeriesProps<T> {
  data: T[]
  x: keyof T & string
  y: keyof T & string
  label: string
  xFormat?: (v: string) => string
  yFormat?: (v: number) => string
  height?: number
}

const config = (label: string): ChartConfig => ({ value: { label, color: 'var(--chart-1)' } })

export function compact(v: number) {
  if (Math.abs(v) >= 100_000) return `${Math.round(v / 1000) / 100}L`
  if (Math.abs(v) >= 1000) return `${Math.round(v / 100) / 10}K`
  return String(v)
}

function Tip({ xFormat, yFormat, label }: { xFormat?: (v: string) => string; yFormat: (v: number) => string; label: string }) {
  return (
    <ChartTooltip
      cursor={{ fill: 'var(--muted)' }}
      content={
        <ChartTooltipContent
          labelFormatter={(value) => (xFormat ? xFormat(String(value)) : String(value))}
          formatter={(value) => (
            <span className="tabular font-medium text-foreground">
              {yFormat(Number(value))} {label}
            </span>
          )}
        />
      }
    />
  )
}

export function Bars<T extends object>({ data, x, y, label, xFormat, yFormat = (v) => v.toLocaleString('en-IN'), height = 240 }: SeriesProps<T>) {
  const rows = data.map((d) => ({ x: String((d as Record<string, unknown>)[x]), value: Number((d as Record<string, unknown>)[y]) }))
  return (
    <ChartContainer config={config(label)} className="w-full" style={{ height }}>
      <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="x" tickFormatter={xFormat} tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} tickFormatter={compact} width={44} />
        <Tip xFormat={xFormat} yFormat={yFormat} label={label} />
        <Bar dataKey="value" fill="var(--color-value)" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  )
}

export function Line<T extends object>({ data, x, y, label, xFormat, yFormat = (v) => v.toLocaleString('en-IN'), height = 240 }: SeriesProps<T>) {
  const rows = data.map((d) => ({ x: String((d as Record<string, unknown>)[x]), value: Number((d as Record<string, unknown>)[y]) }))
  return (
    <ChartContainer config={config(label)} className="w-full" style={{ height }}>
      <AreaChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey="x" tickFormatter={xFormat} tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} tickFormatter={compact} width={44} />
        <Tip xFormat={xFormat} yFormat={yFormat} label={label} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          strokeWidth={2}
          fill="var(--color-value)"
          fillOpacity={0.1}
          dot={false}
          activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}

/** Sequential single-hue fill for a 0–1 share (heatmap, retention). */
export function shade(share: number) {
  const pct = Math.round(8 + Math.max(0, Math.min(1, share)) * 80)
  return `color-mix(in oklab, var(--chart-1) ${pct}%, var(--card))`
}

/** Text that stays readable on a shaded cell. */
export function shadeInk(share: number) {
  return share > 0.55 ? 'white' : 'var(--foreground)'
}
