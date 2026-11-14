import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Square } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/en'
import type { Api } from '@/lib/api'
import { ApiError } from '@/lib/errors'
import { SCAN_KEY, SCAN_PROGRESS_KEY, type ScanProgress } from '@/lib/scan'
import type { ScanFinding, ScanReport, ScanState } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useToast } from './Toaster'
import { providerName, riskText, whereText } from './text'

export function RiskBadges({ risks }: { risks: string[] }) {
  const i18n = useI18n()
  if (risks.length === 0) {
    return (
      <Badge variant="secondary" className="font-normal text-[10px]">
        {i18n.t('riskNone')}
      </Badge>
    )
  }
  return (
    <>
      {risks.map((r) => (
        <Badge
          key={r}
          variant="outline"
          className="border-amber-600/40 font-normal text-[10px] text-amber-800 dark:text-amber-300"
        >
          {riskText(i18n, r)}
        </Badge>
      ))}
    </>
  )
}

function FindingRow({
  finding,
  home,
  chosen,
  onToggle,
  failure,
  onOpen,
}: {
  finding: ScanFinding
  home: string
  chosen: boolean
  onToggle?: (checked: boolean) => void
  failure?: string
  onOpen?: (id: string) => void
}) {
  const i18n = useI18n()
  const { t } = i18n
  const where = whereText(i18n, finding, home)
  const what = [
    finding.provider ? providerName(finding.provider) : '?',
    finding.kind && i18n.has(`kind.${finding.kind}`)
      ? t(`kind.${finding.kind}` as MessageKey)
      : null,
    finding.name,
  ]
    .filter(Boolean)
    .join(' · ')
  const body = (
    <span className="min-w-0 flex-1 space-y-0.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-xs">{finding.redacted}</span>
        <span className="text-muted-foreground text-xs">{what}</span>
      </span>
      <span className="block break-all font-mono text-[11px] text-muted-foreground">{where}</span>
      <span className="flex flex-wrap gap-1">
        <RiskBadges risks={finding.risks} />
      </span>
      {failure && (
        <span className="block text-destructive text-xs">
          {t('scanNotImported', { reason: failure })}
        </span>
      )}
    </span>
  )
  return (
    <li
      data-testid="scan-finding"
      data-severity={finding.severity}
      className={cn(
        'flex items-start gap-2 rounded-md border p-2 text-sm',
        finding.severity === 'amber' && 'border-amber-500/40 bg-amber-500/5',
      )}
    >
      {onToggle ? (
        <label className="flex min-w-0 flex-1 items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={chosen}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`${finding.redacted} · ${where}`}
          />
          {body}
        </label>
      ) : (
        body
      )}
      {finding.stored_id && onOpen && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0"
          onClick={() => onOpen(finding.stored_id as string)}
        >
          {t('scanOpen')}
          <ChevronRight aria-hidden />
        </Button>
      )}
    </li>
  )
}

function Group({
  title,
  hint,
  children,
  collapsed,
}: {
  title: string
  hint?: string
  children: ReactNode
  collapsed?: boolean
}) {
  const id = useId()
  const content = (
    <>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      <ul className="space-y-1.5" aria-labelledby={id}>
        {children}
      </ul>
    </>
  )
  if (collapsed) {
    return (
      <details className="space-y-1.5">
        <summary id={id} className="cursor-pointer font-medium text-sm">
          {title}
        </summary>
        {content}
      </details>
    )
  }
  return (
    <section className="space-y-1.5">
      <h3 id={id} className="font-medium text-sm">
        {title}
      </h3>
      {content}
    </section>
  )
}

/**
 * "Scan" tab: scans the home folder on the server (offline), shows what it found redacted
 * and imports the chosen keys (the server reads each one again from its file). The report
 * holds no secrets; the server forgets it after 30 minutes.
 */
export function ScanPanel({
  api,
  onDone,
  onOpenCredential,
}: {
  api: Api
  onDone: () => void
  onOpenCredential?: (id: string) => void
}) {
  const i18n = useI18n()
  const { t } = i18n
  const toast = useToast()
  const qc = useQueryClient()
  const id = useId()
  const [includeProtected, setIncludeProtected] = useState(false)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [failures, setFailures] = useState<Record<string, string>>({})

  const state = useQuery({ queryKey: SCAN_KEY, queryFn: api.scanState, gcTime: 0 })
  // Filled by the event stream, never fetched.
  const progress = useQuery<ScanProgress | null>({
    queryKey: SCAN_PROGRESS_KEY,
    queryFn: () => null,
    enabled: false,
    gcTime: 0,
  }).data
  // Running or not comes from the server only (refetched on scan_started / scan_done, and
  // on any reconnect); the event stream adds just the file count.
  const running = state.data?.running ?? false

  const start = useMutation({
    mutationFn: () => api.scanStart(includeProtected),
    onMutate: () => {
      setChosen(new Set())
      setFailures({})
      qc.setQueryData<ScanProgress>(SCAN_PROGRESS_KEY, { files: 0, outcome: 'running' })
      // Optimistic, in the server's own state: the next refetch replaces it.
      qc.setQueryData<ScanState>(SCAN_KEY, (old) =>
        old ? { ...old, running: true, report: null } : old,
      )
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: SCAN_KEY }),
    onError: (e: Error) => {
      qc.setQueryData(SCAN_PROGRESS_KEY, null)
      void qc.invalidateQueries({ queryKey: SCAN_KEY })
      toast(t('failed', { message: e.message }), 'error')
    },
  })
  const stop = useMutation({ mutationFn: api.scanStop })
  const importRun = useMutation({
    mutationFn: () => api.scanImport([...chosen]),
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.ok).length
      const failed: Record<string, string> = {}
      for (const x of r.results) {
        if (x.ok) continue
        const key = `scanCode.${x.code}`
        failed[x.id] = i18n.has(key) ? t(key as MessageKey) : (x.message ?? x.code ?? '?')
      }
      setFailures(failed)
      setChosen(new Set())
      void qc.invalidateQueries({ queryKey: ['credentials'] })
      void qc.invalidateQueries({ queryKey: SCAN_KEY })
      if (ok > 0) toast(t('envImported', { count: ok }))
      if (ok > 0 && Object.keys(failed).length === 0) onDone()
    },
    onError: (e: Error) => {
      const expired = e instanceof ApiError && e.status === 404
      toast(expired ? t('scanExpired') : t('failed', { message: e.message }), 'error')
      if (expired) void qc.invalidateQueries({ queryKey: SCAN_KEY })
    },
  })

  const report: ScanReport | null = running ? null : (state.data?.report ?? null)
  const findings = report?.findings ?? []
  const home = report?.home ?? ''
  const sessions = findings.filter((f) => f.session_file)
  const stored = findings.filter((f) => !f.session_file && f.stored_id)
  const rest = findings.filter((f) => !f.session_file && !f.stored_id)
  const high = rest.filter((f) => f.confidence === 'high')
  const low = rest.filter((f) => f.confidence === 'low')
  const toggle = (fid: string) => (checked: boolean) =>
    setChosen((s) => {
      const next = new Set(s)
      if (checked) next.add(fid)
      else next.delete(fid)
      return next
    })

  return (
    <div className="space-y-3" data-testid="scan-panel">
      <p className="text-muted-foreground text-sm">{t('scanHint')}</p>
      <p className="text-muted-foreground text-xs">{t('scanEdrNote')}</p>
      {state.data?.protected_option && !running && (
        <label htmlFor={`${id}-protected`} className="flex items-start gap-2 text-sm">
          <input
            id={`${id}-protected`}
            type="checkbox"
            className="mt-1"
            checked={includeProtected}
            onChange={(e) => setIncludeProtected(e.target.checked)}
          />
          {t('scanProtected')}
        </label>
      )}
      {running ? (
        <div className="flex items-center gap-3" aria-live="polite">
          <span className="text-sm" data-testid="scan-progress">
            {t('scanRunning', { files: i18n.number(progress?.files ?? 0) })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            <Square aria-hidden />
            {t('scanStop')}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant={report ? 'outline' : 'default'}
          disabled={start.isPending || state.isPending}
          onClick={() => start.mutate()}
        >
          {report ? t('scanAgain') : t('scanStart')}
        </Button>
      )}
      <div aria-live="polite">
        {!running && progress?.outcome === 'cancelled' && (
          <p className="text-sm">{t('scanStopped')}</p>
        )}
        {!running && progress?.outcome === 'failed' && (
          <p className="text-destructive text-sm">{t('scanFailed')}</p>
        )}
      </div>

      {report && (
        <div className="space-y-3" data-testid="scan-report">
          <p className="text-sm">
            {t('scanSummary', {
              files: i18n.number(report.files_scanned),
              found: i18n.number(findings.length),
            })}
          </p>
          {report.warnings.map((w) => (
            <p key={w} className="text-amber-800 text-xs dark:text-amber-300">
              {i18n.has(`scanWarn.${w}`) ? t(`scanWarn.${w}` as MessageKey) : w}
            </p>
          ))}
          {findings.length === 0 && <p className="text-sm">{t('scanNothing')}</p>}
          {high.length > 0 && (
            <Group title={t('scanHigh', { count: high.length })}>
              {high.map((f) => (
                <FindingRow
                  key={f.id}
                  finding={f}
                  home={home}
                  chosen={chosen.has(f.id)}
                  onToggle={f.importable ? toggle(f.id) : undefined}
                  failure={failures[f.id]}
                />
              ))}
            </Group>
          )}
          {stored.length > 0 && (
            <Group title={t('scanStoredGroup', { count: stored.length })}>
              {stored.map((f) => (
                <FindingRow
                  key={f.id}
                  finding={f}
                  home={home}
                  chosen={false}
                  onOpen={onOpenCredential}
                />
              ))}
            </Group>
          )}
          {sessions.length > 0 && (
            <Group
              title={t('scanSessionGroup', { count: sessions.length })}
              hint={t('scanSessionHint')}
            >
              {sessions.map((f) => (
                <FindingRow key={f.id} finding={f} home={home} chosen={false} />
              ))}
            </Group>
          )}
          {low.length > 0 && (
            <Group title={t('scanLow', { count: low.length })} collapsed>
              {low.map((f) => (
                <FindingRow key={f.id} finding={f} home={home} chosen={false} />
              ))}
            </Group>
          )}
          {high.some((f) => f.importable) && (
            <Button
              type="button"
              disabled={chosen.size === 0 || importRun.isPending}
              onClick={() => importRun.mutate()}
            >
              {t('envImport', { count: chosen.size })}
            </Button>
          )}
          {report.expires_at && (
            <p className="text-muted-foreground text-xs">
              {t('scanKept', { time: i18n.time(report.expires_at) })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
