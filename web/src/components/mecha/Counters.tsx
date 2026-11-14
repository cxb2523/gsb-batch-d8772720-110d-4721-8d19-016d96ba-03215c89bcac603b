import { animate, useReducedMotionConfig } from 'motion/react'
import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n'
import type { Overall } from '@/lib/types'
import { cn } from '@/lib/utils'
import { STATUS } from './status'

/** Number ticker: animates between values, or jumps when the user prefers reduced motion. */
function Ticker({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(value)
  const reduce = useReducedMotionConfig()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduce || prev.current === value) {
      el.textContent = String(value)
      prev.current = value
      return
    }
    const controls = animate(prev.current, value, {
      duration: 0.6,
      ease: 'easeOut',
      onUpdate: (v) => {
        el.textContent = String(Math.round(v))
      },
    })
    prev.current = value
    return () => controls.stop()
  }, [value, reduce])
  return <span ref={ref}>{value}</span>
}

// The four spec counters plus «local only», so the counters always add up to the total.
const ORDER: Overall[] = ['green', 'amber', 'red', 'grey', 'local']

export function Counters({
  counts,
  active,
  onToggle,
}: {
  counts: Record<Overall, number>
  active: Overall | null
  onToggle: (o: Overall) => void
}) {
  const { t } = useI18n()
  return (
    <ul className="flex flex-wrap gap-2" aria-label={t('filterStatus')}>
      {ORDER.map((o) => {
        const { icon: Icon, tone } = STATUS[o]
        return (
          <li key={o}>
            <button
              type="button"
              aria-pressed={active === o}
              data-testid={`counter-${o}`}
              onClick={() => onToggle(o)}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm ring-1 ring-inset focus-visible:outline-2 focus-visible:outline-ring',
                tone,
                active === o && 'ring-2',
              )}
            >
              <Icon aria-hidden="true" className="size-4" />
              <span className="font-semibold tabular-nums">
                <Ticker value={counts[o]} />
              </span>
              <span>{t(`status.${o}`)}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
