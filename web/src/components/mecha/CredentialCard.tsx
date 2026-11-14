import { RefreshCw } from 'lucide-react'
import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import type { Api } from '@/lib/api'
import type { CredentialStatus, ProbeInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Fuse, fuseModel } from './Fuse'
import { ProbeButton } from './ProbeButton'
import { StatusPill } from './StatusPill'
import {
  checkedLine,
  fundsInfoLine,
  fundsLine,
  limitsLine,
  providerName,
  reasonsLine,
} from './text'

export function ProviderMark({ provider }: { provider: string }) {
  const letters: Record<string, string> = {
    anthropic: 'A',
    openai: 'O',
    gemini: 'G',
    xai: 'x',
    openrouter: 'OR',
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-mono font-semibold text-sm"
    >
      {letters[provider] ?? '?'}
    </span>
  )
}

interface Props {
  item: CredentialStatus
  now: string
  horizonDays: number
  probe?: ProbeInfo | null
  api?: Api
  onOpen: (id: string) => void
  onCheck: (id: string) => void
  checking: boolean
}

export const CredentialCard = memo(function CredentialCard({
  item,
  now,
  horizonDays,
  probe,
  api,
  onOpen,
  onCheck,
  checking,
}: Props) {
  const i18n = useI18n()
  const { t } = i18n
  const c = item.credential
  const overall = item.result.overall
  const limits = limitsLine(i18n, item)
  const fundsInfo = fundsInfoLine(i18n, item)
  const remote = c.kind !== 'oauth_token' && c.kind !== 'oauth_file'
  const headingId = `cred-${c.id}`
  return (
    <Card
      data-testid="credential-card"
      data-overall={overall}
      aria-labelledby={headingId}
      role="article"
      className={cn('gap-3 py-4', overall === 'red' && 'mecha-burning')}
    >
      <CardHeader className="flex flex-row items-start gap-3 px-4">
        <ProviderMark provider={c.provider} />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id={headingId} className="truncate font-medium text-base leading-tight">
            <button
              type="button"
              className="rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              onClick={() => onOpen(c.id)}
            >
              {c.label}
            </button>
          </h2>
          <p className="truncate font-mono text-muted-foreground text-xs">{c.redacted}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusPill overall={overall} />
          <Badge variant="outline" className="font-normal text-[11px]">
            {providerName(c.provider)} · {t(`kind.${c.kind}`)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        <p className="min-h-4 text-xs" data-testid="reasons">
          {reasonsLine(i18n, item, now)}
        </p>
        <Fuse model={fuseModel(item, now, t, i18n.relative, horizonDays)} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">{t('signal.funds')}</dt>
          <dd>{fundsLine(i18n, item)}</dd>
          {limits && (
            <>
              <dt className="text-muted-foreground">{t('signal.limits')}</dt>
              <dd>{limits}</dd>
            </>
          )}
        </dl>
        {fundsInfo && <p className="text-muted-foreground text-xs">{fundsInfo}</p>}
        <div className="flex items-center justify-between gap-1 pt-1">
          <span className="mr-auto text-muted-foreground text-xs">
            {checkedLine(i18n, item, now)}
          </span>
          {remote && probe && api && c.kind === 'api_key' && (
            <ProbeButton item={item} probe={probe} api={api} now={now} />
          )}
          {remote && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${t('checkNow')}: ${c.label}`}
                  disabled={checking}
                  onClick={() => onCheck(c.id)}
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cn(checking && 'motion-safe:animate-spin')}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('checkNow')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </CardContent>
    </Card>
  )
})
