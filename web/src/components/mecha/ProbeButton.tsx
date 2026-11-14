import { useQueryClient } from '@tanstack/react-query'
import { Zap } from 'lucide-react'
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import type { Api } from '@/lib/api'
import { ApiError } from '@/lib/errors'
import type { CredentialStatus, ProbeInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useToast } from './Toaster'

export function probeCostText(t: ReturnType<typeof useI18n>['t'], probe: ProbeInfo): string {
  return t('probeCost', {
    input: probe.input_tokens,
    output: probe.output_tokens,
    model: probe.model,
    usd: Number(probe.usd_per_probe).toPrecision(2),
  })
}

/**
 * The paid active probe. One per credential and hour: when the server says it is too soon,
 * a confirmation dialog (focus on Cancel) shows when the next one is due and what it costs.
 */
export function ProbeButton({
  item,
  probe,
  api,
  now,
  size = 'icon-sm',
}: {
  item: CredentialStatus
  probe: ProbeInfo
  api: Api
  now: string
  size?: 'icon-sm' | 'sm'
}) {
  const i18n = useI18n()
  const { t } = i18n
  const toast = useToast()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [nextAt, setNextAt] = useState<string | null>(null)
  const id = item.credential.id

  const run = async (force: boolean) => {
    setBusy(true)
    try {
      await api.probe(id, force)
      toast(t('probeDone'))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'probe_too_soon') {
        setNextAt(item.probe_next_at ?? new Date(Date.now() + 3_600_000).toISOString())
        return
      }
      toast(t('failed', { message: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['credentials'] })
      void qc.invalidateQueries({ queryKey: ['history', id] })
    }
  }

  const cost = probeCostText(t, probe)
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size={size}
            variant="ghost"
            aria-label={`${t('probeAction')}: ${item.credential.label}. ${cost}`}
            disabled={busy}
            onClick={() => void run(false)}
          >
            <Zap aria-hidden="true" className={cn(busy && 'motion-safe:animate-pulse')} />
            {size === 'sm' && t('probeAction')}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{cost}</TooltipContent>
      </Tooltip>
      <AlertDialog open={nextAt !== null} onOpenChange={(open) => !open && setNextAt(null)}>
        <AlertDialogContent data-testid="probe-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('probeTooSoonTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('probeTooSoon', {
                when: nextAt ? i18n.relative(nextAt, now) : '',
                usd: Number(probe.usd_per_probe).toPrecision(2),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setNextAt(null)
                void run(true)
              }}
            >
              {t('probeNow')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
