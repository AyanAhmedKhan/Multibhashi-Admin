import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '../lib/api'

/** "Resend code" with a 30-second countdown (the server enforces the same cooldown). */
export function ResendCode({ onResend }: { onResend: () => Promise<{ sentTo?: string | null }> }) {
  const [wait, setWait] = useState(30)
  useEffect(() => {
    if (wait <= 0) return
    const t = setTimeout(() => setWait((w) => w - 1), 1000)
    return () => clearTimeout(t)
  }, [wait])
  return (
    <button
      type="button"
      disabled={wait > 0}
      className="block w-full text-center text-xs text-muted-foreground underline-offset-4 enabled:hover:text-foreground enabled:hover:underline disabled:opacity-60"
      onClick={async () => {
        try {
          const res = await onResend()
          toast.success(`New code sent${res.sentTo ? ` to ${res.sentTo}` : ''}`)
          setWait(30)
        } catch (error) {
          toast.error(error instanceof ApiError ? error.message : 'Couldn’t send a new code')
        }
      }}
    >
      {wait > 0 ? `Didn’t get it? Resend in ${wait} s` : 'Didn’t get it? Send a new code'}
    </button>
  )
}
