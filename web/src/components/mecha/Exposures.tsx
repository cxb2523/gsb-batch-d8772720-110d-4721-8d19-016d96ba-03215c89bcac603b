import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import type { Api } from '@/lib/api'
import type { Credential } from '@/lib/types'
import { RiskBadges } from './ScanPanel'
import { useToast } from './Toaster'
import { whereText } from './text'

/**
 * Where `mecha scan` found this stored key in plaintext. The locations are kept encrypted
 * on the server and fetched only while the sheet is open. "Scan these files again" sends
 * the credential id only: the server reads the paths it already has.
 */
export function ExposuresSection({
  credential,
  api,
  now,
  paused = false,
}: {
  credential: Credential
  api: Api
  now: string
  /** While the credential is being deleted: refetching its locations would 404. */
  paused?: boolean
}) {
  const i18n = useI18n()
  const { t } = i18n
  const toast = useToast()
  const qc = useQueryClient()
  const id = credential.id
  const summary = credential.facts?.exposure
  const where = useQuery({
    queryKey: ['exposures', id],
    queryFn: () => api.exposures(id),
    enabled: !!summary && !paused,
  })
  const rescan = useMutation({
    mutationFn: () => api.rescanExposures(id),
    onSuccess: (data) => {
      qc.setQueryData(['exposures', id], data)
      void qc.invalidateQueries({ queryKey: ['credentials'] })
      if (data.exposures.length === 0) toast(t('exposuresClean'))
    },
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  if (!summary) return null
  const items = where.data?.exposures ?? []
  return (
    <section aria-label={t('exposuresTitle')} data-testid="exposures">
      <h3 className="mb-1 font-medium text-sm">{t('exposuresTitle')}</h3>
      <p className="mb-2 text-muted-foreground text-xs">
        {t('exposuresScanned', { when: i18n.relative(summary.scanned_at, now) })}
      </p>
      <ul className="space-y-1.5">
        {items.map((e) => (
          <li
            key={`${e.path}:${e.line}:${e.cell_line ?? 0}:${e.column}`}
            className="space-y-0.5 rounded-md border p-2"
          >
            <span className="block break-all font-mono text-[11px]">
              {whereText(i18n, e, where.data?.home ?? '')}
            </span>
            <span className="flex flex-wrap gap-1">
              <RiskBadges risks={e.risks} />
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-muted-foreground text-xs">{t('exposuresHint')}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-2"
        disabled={rescan.isPending || where.isPending}
        onClick={() => rescan.mutate()}
      >
        {t('exposuresRescan')}
      </Button>
    </section>
  )
}
