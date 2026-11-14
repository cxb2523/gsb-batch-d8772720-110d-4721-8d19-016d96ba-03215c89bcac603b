import { useI18n } from '@/i18n'
import type { Overall } from '@/lib/types'
import { cn } from '@/lib/utils'
import { STATUS } from './status'

export function StatusPill({ overall, className }: { overall: Overall; className?: string }) {
  const { t } = useI18n()
  const { icon: Icon, tone } = STATUS[overall]
  return (
    <span
      data-status={overall}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs ring-1 ring-inset',
        tone,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {t(`status.${overall}`)}
    </span>
  )
}
