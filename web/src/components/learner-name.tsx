import { UserRound } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { initials } from '../pages/admin/StaffPage'

export type NameSource = 'account' | 'enquiry' | null

/**
 * A learner's name as the API resolved it: the account name, the name on one of their CRM
 * enquiries (the account still has the app's placeholder "User"), or none yet.
 */
export function LearnerName({ name, source, className }: { name: string | null; source?: NameSource; className?: string }) {
  if (!name) return <span className={cn('italic text-muted-foreground', className)}>No name yet</span>
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-1.5', className)}>
      {name}
      {source === 'enquiry' && (
        <span className="text-xs font-normal text-muted-foreground" title="The account has no name yet; this one is from the learner’s CRM enquiry">
          (from enquiry)
        </span>
      )}
    </span>
  )
}

export function LearnerAvatar({ name, className, textClassName }: { name: string | null; className?: string; textClassName?: string }) {
  return (
    <Avatar className={className}>
      <AvatarFallback className={cn('bg-accent font-semibold text-accent-foreground', textClassName)}>
        {name ? initials(name) : <UserRound className="size-1/2" aria-hidden />}
      </AvatarFallback>
    </Avatar>
  )
}
