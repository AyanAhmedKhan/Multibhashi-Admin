import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { api, ApiError, onStepUp } from '../lib/api'
import { Button, ErrorNote, Field, Input, Modal, Textarea } from './ui'

/**
 * Two dialogs every page shares:
 * - step-up: the API answered STEP_UP_REQUIRED; ask for an authenticator code and retry;
 * - reason: sensitive reads and every write ask "why?" (stored in the audit log).
 */

interface ReasonRequest {
  title: string
  description?: ReactNode
  confirmLabel?: string
  danger?: boolean
  /** Text the person must type to confirm (for irreversible actions). */
  confirmText?: string
  extra?: ReactNode
  run: (reason: string) => Promise<unknown>
}

const ReasonContext = createContext<((req: ReasonRequest) => void) | null>(null)

export function DialogsProvider({ children }: { children: ReactNode }) {
  // --- step-up
  const [stepUpOpen, setStepUpOpen] = useState(false)
  const [code, setCode] = useState('')
  const [stepError, setStepError] = useState<unknown>(null)
  const [stepBusy, setStepBusy] = useState(false)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  useEffect(() => {
    onStepUp(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve
          setCode('')
          setStepError(null)
          setStepUpOpen(true)
        })
    )
  }, [])

  const closeStepUp = (ok: boolean) => {
    setStepUpOpen(false)
    resolver.current?.(ok)
    resolver.current = null
  }

  const submitStepUp = async () => {
    setStepBusy(true)
    setStepError(null)
    try {
      await api.post('auth/step-up', { code })
      closeStepUp(true)
    } catch (error) {
      setStepError(error)
    } finally {
      setStepBusy(false)
    }
  }

  // --- reason
  const [req, setReq] = useState<ReasonRequest | null>(null)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [reasonError, setReasonError] = useState<unknown>(null)
  const [reasonBusy, setReasonBusy] = useState(false)

  const ask = useCallback((next: ReasonRequest) => {
    setReq(next)
    setReason('')
    setTyped('')
    setReasonError(null)
  }, [])

  const submitReason = async () => {
    if (!req) return
    setReasonBusy(true)
    setReasonError(null)
    try {
      await req.run(reason.trim())
      setReq(null)
    } catch (error) {
      setReasonError(error)
    } finally {
      setReasonBusy(false)
    }
  }

  const reasonOk = reason.trim().length >= 5 && (!req?.confirmText || typed.trim() === req.confirmText)
  const fieldError = reasonError instanceof ApiError ? reasonError.fields?.reason : undefined

  return (
    <ReasonContext.Provider value={ask}>
      {children}

      <Modal
        open={stepUpOpen}
        title="Confirm it’s you"
        onClose={() => closeStepUp(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => closeStepUp(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={stepBusy} disabled={code.trim().length < 6} onClick={submitStepUp}>
              Confirm
            </Button>
          </>
        }
      >
        <div className="flex gap-3 text-sm text-ink-2">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <p>This action changes money, access or personal data. Enter the 6-digit code from your authenticator app (or a recovery code).</p>
        </div>
        <Field label="Code">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && code.trim().length >= 6 && submitStepUp()}
              placeholder="123456"
            />
          )}
        </Field>
        <ErrorNote error={stepError} />
      </Modal>

      <Modal
        open={!!req}
        title={req?.title ?? ''}
        onClose={() => setReq(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReq(null)}>
              Cancel
            </Button>
            <Button variant={req?.danger ? 'danger' : 'primary'} loading={reasonBusy} disabled={!reasonOk} onClick={submitReason}>
              {req?.confirmLabel ?? 'Continue'}
            </Button>
          </>
        }
      >
        {req?.description && <div className="text-sm text-ink-2">{req.description}</div>}
        {req?.extra}
        <Field label="Reason" hint="Saved in the audit log with your name. A ticket number or one sentence is enough." error={fieldError}>
          {(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ticket #4821: learner says the class cut off" />}
        </Field>
        {req?.confirmText && (
          <Field label={`Type “${req.confirmText}” to confirm`}>
            {(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} />}
          </Field>
        )}
        <ErrorNote error={reasonError && !fieldError ? reasonError : null} />
      </Modal>
    </ReasonContext.Provider>
  )
}

export function useReason() {
  const ask = useContext(ReasonContext)
  if (!ask) throw new Error('useReason outside DialogsProvider')
  return ask
}
