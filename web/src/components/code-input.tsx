import { useState } from 'react'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@/components/ui/input-otp'
import { Input } from './ui'

/**
 * The authenticator code: six boxes (auto-submits when full), or, for someone who lost
 * their phone, one of their single-use recovery codes.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  allowRecovery = true,
  autoFocus = true,
}: {
  value: string
  onChange: (v: string) => void
  onComplete?: (v: string) => void
  allowRecovery?: boolean
  autoFocus?: boolean
}) {
  const [recovery, setRecovery] = useState(false)
  return (
    <div className="space-y-2">
      {recovery ? (
        <Input
          aria-label="Recovery code"
          autoFocus
          autoComplete="off"
          placeholder="xxxxx-xxxxx"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value.trim().length >= 10 && onComplete?.(value)}
        />
      ) : (
        <InputOTP
          maxLength={6}
          pattern={REGEXP_ONLY_DIGITS}
          value={value}
          onChange={onChange}
          onComplete={onComplete}
          autoFocus={autoFocus}
          aria-label="Authenticator code"
          containerClassName="justify-center"
        >
          <InputOTPGroup>
            <InputOTPSlot index={0} className="size-11 text-lg" />
            <InputOTPSlot index={1} className="size-11 text-lg" />
            <InputOTPSlot index={2} className="size-11 text-lg" />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            <InputOTPSlot index={3} className="size-11 text-lg" />
            <InputOTPSlot index={4} className="size-11 text-lg" />
            <InputOTPSlot index={5} className="size-11 text-lg" />
          </InputOTPGroup>
        </InputOTP>
      )}
      {allowRecovery && (
        <button
          type="button"
          className="block w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => {
            setRecovery((r) => !r)
            onChange('')
          }}
        >
          {recovery ? 'Use the code from my authenticator app' : 'Lost your phone? Use a recovery code'}
        </button>
      )}
    </div>
  )
}

/** True when the input looks complete enough to submit. */
export const codeReady = (code: string) => /^\d{6}$/.test(code) || code.replace(/[^a-z0-9]/gi, '').length === 10
