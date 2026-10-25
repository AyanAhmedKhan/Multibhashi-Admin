import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Mail, MessageCircle, QrCode, Share2, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { fmtDateTime } from '../lib/format'
import { Badge, Button, Input } from './ui'

/**
 * Everything needed to hand a one-time setup link to a new staff member: copy, WhatsApp,
 * email, the phone's share sheet, or a QR code to scan from the screen.
 */
export function ShareInvite({
  link,
  name,
  email,
  expiresAt,
  superAdmin,
  emailed,
  emailError,
}: {
  link: string
  name: string
  email: string
  expiresAt?: string | null
  superAdmin?: 'granted' | null
  emailed?: boolean
  emailError?: string | null
}) {
  const [copied, setCopied] = useState(false)
  const [qr, setQr] = useState(false)
  const first = name.split(/\s+/)[0]
  const message = `Hi ${first}, here is your invite to the MultiBhashi Admin Console. Open this link and choose your password. The link works once and expires ${expiresAt ? fmtDateTime(expiresAt) : 'in 48 hours'}.\n\n${link}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      toast.success('Invite link copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Couldn’t copy. Select the link and copy it.')
    }
  }
  const share = async () => {
    try {
      await navigator.share({ title: 'MultiBhashi Console invite', text: message })
    } catch {
      /* cancelled */
    }
  }

  return (
    <div className="space-y-4">
      {emailed && (
        <p className="flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          <Mail className="size-4" /> Emailed to {email}. You can also share the link below.
        </p>
      )}
      {emailError && <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">The email didn’t go out ({emailError}). Share the link below instead.</p>}
      {superAdmin === 'granted' && <Badge tone="violet">Super Admin</Badge>}
      <div className="flex gap-2">
        <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" className="font-mono text-xs" />
        <Button onClick={copy} icon={copied ? <Check /> : <Copy />} aria-label="Copy link">
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Button variant="outline" icon={<MessageCircle />} onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener')}>
          WhatsApp
        </Button>
        <Button
          variant="outline"
          icon={<Mail />}
          onClick={() => {
            window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Your MultiBhashi Console invite')}&body=${encodeURIComponent(message)}`
          }}
        >
          Email
        </Button>
        {typeof navigator !== 'undefined' && 'share' in navigator && (
          <Button variant="outline" icon={<Share2 />} onClick={share}>
            Share…
          </Button>
        )}
        <Button variant="outline" icon={<QrCode />} onClick={() => setQr((v) => !v)}>
          {qr ? 'Hide QR' : 'QR code'}
        </Button>
      </div>
      {qr && (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-white p-4">
          <QRCodeSVG value={link} size={176} />
          <span className="text-xs text-slate-500">Scan with the phone’s camera to open the invite</span>
        </div>
      )}
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Anyone with this link can claim the account until it’s used or expires{expiresAt ? ` (${fmtDateTime(expiresAt)})` : ''}. Send it only to {first}, directly.
      </p>
    </div>
  )
}
