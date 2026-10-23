/**
 * The console's building blocks, on shadcn/ui (Radix). Screens import from here, so the
 * look and behaviour (focus traps, keyboard support, theming) live in one place.
 */
import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, Loader2 } from 'lucide-react'
import { Button as UIButton } from '@/components/ui/button'
import { Badge as UIBadge } from '@/components/ui/badge'
import { Card as UICard, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input as UIInput } from '@/components/ui/input'
import { Textarea as UITextarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table as UITable, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs as UITabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { ApiError } from '../lib/api'

export const cx = cn

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
const VARIANT = { primary: 'default', secondary: 'outline', outline: 'outline', ghost: 'ghost', danger: 'destructive' } as const

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode }) {
  const iconOnly = !children
  return (
    <UIButton
      variant={VARIANT[variant]}
      size={iconOnly ? (size === 'sm' ? 'icon-sm' : 'icon') : size === 'md' ? 'default' : size}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : icon}
      {children}
    </UIButton>
  )
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <UICard className={cn('min-w-0 gap-0 py-0', className)}>
      {(title || actions) && (
        <CardHeader className="border-b px-5 py-4 [.border-b]:pb-4">
          {title && <CardTitle className="text-[15px]">{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
          {actions && <CardAction className="flex flex-wrap items-center gap-2">{actions}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={padded ? 'p-5' : 'p-0'}>{children}</CardContent>
    </UICard>
  )
}

const TONE = {
  neutral: 'border-transparent bg-muted text-muted-foreground',
  blue: 'border-transparent bg-accent text-accent-foreground',
  green: 'border-transparent bg-success-soft text-success',
  amber: 'border-transparent bg-warning-soft text-warning',
  red: 'border-transparent bg-danger-soft text-danger',
  violet: 'border-transparent bg-violet-soft text-violet',
}
export type Tone = keyof typeof TONE

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <UIBadge className={cn('gap-1 font-medium', TONE[tone], className)}>{children}</UIBadge>
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function Stat({ label, value, hint, tone, icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; icon?: ReactNode }) {
  return (
    <UICard className="gap-1 px-4 py-4">
      <div className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
        <span>{label}</span>
        {icon && <span className="text-muted-foreground/70 [&_svg]:size-4">{icon}</span>}
      </div>
      <div className={cn('tabular text-2xl font-semibold tracking-tight', tone === 'red' ? 'text-danger' : tone === 'amber' ? 'text-warning' : 'text-foreground')}>
        {value}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </UICard>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-[13px] text-ink-2">
        {label}
      </Label>
      {children(id)}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <UIInput {...props} className={cn('h-9', props.className)} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <UITextarea {...props} className={cn('min-h-20', props.className)} />
}

/** A native select styled like the shadcn inputs (keeps forms simple and mobile-friendly). */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow]',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
        props.className
      )}
    />
  )
}

/** Loading placeholder shaped like content (rows of text). */
export function Spinner({ label = 'Loading', rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3 p-5" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-4', i % 3 === 2 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  const message = error instanceof ApiError ? error.message : 'Something went wrong.'
  const forbidden = error instanceof ApiError && error.code === 'FORBIDDEN'
  return (
    <Alert variant="destructive" className="my-2">
      <AlertTriangle aria-hidden />
      <AlertDescription>{forbidden ? 'You don’t have access to this. Ask a Super Admin if you need it.' : message}</AlertDescription>
    </Alert>
  )
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon ?? <Inbox />}</div>
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mt-1 max-w-md text-sm text-muted-foreground">{children}</p>}
    </div>
  )
}

/** A table that scrolls sideways inside its card, never the page. */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <UITable>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {head.map((h, i) => (
            <TableHead key={i} className="h-10 px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </UITable>
  )
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <TableCell className={cn('px-4 py-3 align-top whitespace-normal', className)}>{children}</TableCell>
}

export function Pagination({ page, lastPage, total, onPage }: { page: number; lastPage: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
      <span>
        {lastPage > 1 ? `Page ${page} of ${lastPage} · ` : ''}
        {total.toLocaleString('en-IN')} total
      </span>
      {lastPage > 1 && (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page" icon={<ChevronLeft />} />
          <Button size="sm" variant="outline" disabled={page >= lastPage} onClick={() => onPage(page + 1)} aria-label="Next page" icon={<ChevronRight />} />
        </div>
      )}
    </div>
  )
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className={cn('max-h-[92vh] overflow-y-auto', wide ? 'sm:max-w-3xl' : 'sm:max-w-md')}
        // Forms don't vanish on a stray click, and a dialog opened on top of another (the
        // "reason" prompt over Give AI Pro) must not count as clicking outside it.
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-4">{children}</div>
        {footer && <DialogFooter className="gap-2">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <UITabs value={value} onValueChange={(v) => onChange(v as T)} className="mb-4 min-w-0">
      {/* Scrolls on its own on narrow screens instead of widening the page */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <TabsList className="w-max">
          {items.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </UITabs>
  )
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="mt-0.5 wrap-break-word">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export { Skeleton }
