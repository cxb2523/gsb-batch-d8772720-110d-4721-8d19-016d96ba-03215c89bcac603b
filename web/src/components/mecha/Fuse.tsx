import { motion, useReducedMotionConfig } from 'motion/react'
import type { useI18n } from '@/i18n'
import type { CredentialStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { STATUS } from './status'

const DAY = 86_400_000

export interface FuseModel {
  /** 0..1 left to burn, or null when nothing is known. */
  fraction: number | null
  tone: 'green' | 'amber' | 'red' | 'grey'
  text: string
}

/** Tone from the expiry state computed by the backend (which knows `soon_days`). */
const TONE: Record<string, FuseModel['tone']> = {
  expired: 'red',
  soon: 'amber',
  scheduled: 'green',
  none: 'green',
}

export function fuseModel(
  item: CredentialStatus,
  now: string,
  t: ReturnType<typeof useI18n>['t'],
  relative: ReturnType<typeof useI18n>['relative'],
  horizonDays: number,
): FuseModel {
  const expiry = item.result.expiry.value
  const expiresAt = expiry.expires_at
  if (expiresAt) {
    // A fixed horizon: the same time left draws the same length on every card, whenever the
    // key was added. Beyond the horizon the fuse is simply full.
    const left = new Date(expiresAt).getTime() - new Date(now).getTime()
    const fraction = Math.min(1, Math.max(0, left / (horizonDays * DAY)))
    const tone = TONE[expiry.state] ?? 'grey'
    const isSubscription =
      item.credential.subscription_until !== null &&
      item.credential.subscription_until === expiresAt
    const text =
      left <= 0
        ? t('fuseExpired', { when: relative(expiresAt, now) })
        : t(isSubscription ? 'fuseSubscription' : 'fuseExpires', { when: relative(expiresAt, now) })
    return { fraction, tone, text }
  }
  return { fraction: null, tone: 'grey', text: t('fuseNoDate') }
}

/** The signature component: a fuse that burns down towards expiry. */
export function Fuse({ model, className }: { model: FuseModel; className?: string }) {
  const reduce = useReducedMotionConfig()
  if (model.fraction === null) {
    return (
      <div className={cn('space-y-1', className)}>
        <div
          role="img"
          aria-label={model.text}
          className="h-1.5 w-full rounded-full border border-zinc-500/60 border-dashed"
        />
        <p className="text-muted-foreground text-xs">{model.text}</p>
      </div>
    )
  }
  const pct = Math.round(model.fraction * 100)
  return (
    <div className={cn('space-y-1', className)}>
      <meter className="sr-only" min={0} max={100} value={pct} aria-label={model.text}>
        {pct}%
      </meter>
      <div aria-hidden="true" className="relative h-1.5 w-full rounded-full bg-muted">
        <div
          data-testid="fuse-bar"
          className={cn('h-full rounded-full', STATUS[model.tone].bar)}
          style={{ width: `${pct}%` }}
        />
        {!reduce && pct > 0 && (
          <motion.span
            data-testid="fuse-spark"
            aria-hidden="true"
            className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 size-2 rounded-full bg-amber-300 shadow-[0_0_8px_2px] shadow-amber-400/70"
            style={{ left: `${pct}%` }}
            animate={{ scale: [1, 1.35, 0.9, 1.2, 1], opacity: [1, 0.8, 1, 0.85, 1] }}
            transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
          />
        )}
      </div>
      <p className="text-muted-foreground text-xs">{model.text}</p>
    </div>
  )
}
