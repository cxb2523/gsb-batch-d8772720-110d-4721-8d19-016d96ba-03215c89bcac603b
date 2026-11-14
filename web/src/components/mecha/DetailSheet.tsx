import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { Line, LineChart, YAxis } from 'recharts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChartContainer } from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/en'
import type { Api } from '@/lib/api'
import { STATIC_DEMO } from '@/lib/edition'
import type { CredentialStatus, ProbeInfo, Signal, Source } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ExposuresSection } from './Exposures'
import { Fuse, fuseModel } from './Fuse'
import { ProbeButton, probeCostText } from './ProbeButton'
import { StatusPill } from './StatusPill'
import { STATUS } from './status'
import { useToast } from './Toaster'
import {
  checkedLine,
  fundsInfoLine,
  fundsLine,
  limitsLine,
  providerName,
  reasonsLine,
} from './text'

function SourceChip({ source }: { source: Source }) {
  const { t } = useI18n()
  const unverified = source === 'jwt' || source === 'file'
  return (
    <Badge variant="secondary" className="font-normal text-[10px]">
      {t(`source.${source}` as MessageKey)}
      {unverified && ` · ${t('unverified')}`}
    </Badge>
  )
}

function SignalRow({
  label,
  value,
  signal,
}: {
  label: string
  value: string
  signal: Signal<unknown>
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="flex items-center gap-2 text-right text-sm">
        {value}
        <SourceChip source={signal.source} />
      </dd>
    </div>
  )
}

const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '')

export function DetailSheet({
  item,
  now,
  horizonDays,
  api,
  probe,
  onClose,
}: {
  item: CredentialStatus | null
  now: string
  api: Api
  horizonDays: number
  probe?: ProbeInfo | null
  onClose: () => void
}) {
  const i18n = useI18n()
  const { t } = i18n
  const toast = useToast()
  const qc = useQueryClient()
  const formId = useId()
  const id = item?.credential.id ?? null
  const [label, setLabel] = useState('')
  const [tags, setTags] = useState('')
  const [notes, setNotes] = useState('')
  const [expiry, setExpiry] = useState('')
  const [budgetAmount, setBudgetAmount] = useState('')
  const [budgetDate, setBudgetDate] = useState('')

  useEffect(() => {
    if (!item) return
    setLabel(item.credential.label)
    setTags(item.credential.tags.join(', '))
    setNotes(item.credential.notes ?? '')
    setExpiry(toDateInput(item.credential.manual_expires_at))
    setBudgetAmount(item.credential.manual_budget?.amount ?? '')
    setBudgetDate(toDateInput(item.credential.manual_budget?.purchased_at ?? null))
  }, [item])

  // History is fetched only when the sheet is open (never one request per card).
  // Deleting disables the history query: the deletion event can arrive before the DELETE
  // response, and refetching the history of a removed credential would 404.
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const history = useQuery({
    queryKey: ['history', id],
    queryFn: () => api.history(id as string, 50),
    enabled: id !== null && !deleting,
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['credentials'] })
    void qc.invalidateQueries({ queryKey: ['history', id] })
  }
  const save = useMutation({
    mutationFn: () =>
      api.patch(id as string, {
        label,
        tags: tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        notes: notes.trim() ? notes : null,
        manual_expires_at: expiry ? `${expiry}T00:00:00Z` : null,
      }),
    onSuccess: () => {
      toast(t('saved'))
      refresh()
    },
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  const toggleProbe = useMutation({
    mutationFn: (on: boolean) => api.patch(id as string, { active_probe: on }),
    onSuccess: refresh,
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  const saveBudget = useMutation({
    mutationFn: () =>
      api.patch(id as string, {
        manual_budget: {
          amount: budgetAmount,
          currency: 'USD',
          purchased_at: `${budgetDate}T00:00:00Z`,
        },
      }),
    onSuccess: () => {
      toast(t('budgetSaved'))
      refresh()
    },
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  const clearBudget = useMutation({
    mutationFn: () => api.patch(id as string, { manual_budget: null }),
    onSuccess: refresh,
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  const check = useMutation({
    mutationFn: () => api.check(id as string),
    onSuccess: refresh,
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  const remove = useMutation({
    mutationFn: () => api.remove(id as string),
    onMutate: async () => {
      setDeleting(true)
      await qc.cancelQueries({ queryKey: ['history', id] })
      qc.removeQueries({ queryKey: ['history', id] })
    },
    onSuccess: () => {
      toast(t('deleted'))
      onClose()
      void qc.invalidateQueries({ queryKey: ['credentials'] })
    },
    onError: (e: Error) => {
      setDeleting(false)
      toast(t('failed', { message: e.message }), 'error')
    },
  })

  const r = item?.result
  const points = [...(history.data?.history ?? [])].reverse()
  const latency = points
    .filter((p) => p.http?.latency_ms != null)
    .map((p, index) => ({ index, ms: p.http?.latency_ms ?? 0 }))
  const remote =
    item && item.credential.kind !== 'oauth_token' && item.credential.kind !== 'oauth_file'

  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-lg"
        data-testid="detail-sheet"
        // One Escape closes one layer. Radix hands the same keydown to the sheet as well, so
        // while the delete confirmation is open the sheet closes the confirmation itself and
        // stays open (before this, one Escape closed both, every time).
        onEscapeKeyDown={(e) => {
          if (confirmOpen) {
            e.preventDefault()
            setConfirmOpen(false)
          }
        }}
      >
        {item && r && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {item.credential.label}
                <StatusPill overall={r.overall} />
              </SheetTitle>
              <SheetDescription className="font-mono">
                {providerName(item.credential.provider)} · {t(`kind.${item.credential.kind}`)} ·{' '}
                {item.credential.redacted}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-4 pb-6">
              <section aria-labelledby={`${formId}-why`} className="space-y-2">
                <p id={`${formId}-why`} className="text-sm">
                  {reasonsLine(i18n, item, now)}
                </p>
                <Fuse model={fuseModel(item, now, t, i18n.relative, horizonDays)} />
                <p className="text-muted-foreground text-xs">{checkedLine(i18n, item, now)}</p>
                {remote && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={check.isPending}
                    onClick={() => check.mutate()}
                  >
                    {t('checkNow')}
                  </Button>
                )}
                {remote && probe && item.credential.kind === 'api_key' && (
                  <div className="space-y-1 rounded-md border p-3" data-testid="probe-section">
                    <ProbeButton item={item} probe={probe} api={api} now={now} size="sm" />
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={item.credential.active_probe}
                        onChange={(e) => toggleProbe.mutate(e.target.checked)}
                      />
                      <span>{t('probeAuto')}</span>
                    </label>
                    <p className="text-muted-foreground text-xs">{probeCostText(t, probe)}</p>
                    <p className="text-muted-foreground text-xs">
                      {t('probeMonthly', {
                        usd: probe.usd_per_month_label,
                        hours: probe.interval_hours,
                      })}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t('probePrices', { date: i18n.date(probe.prices_checked) })}
                    </p>
                  </div>
                )}
              </section>

              <section aria-label={t('signals')}>
                <h3 className="mb-1 font-medium text-sm">{t('signals')}</h3>
                <dl className="divide-y">
                  <SignalRow
                    label={t('signal.validity')}
                    value={
                      i18n.has(`validity.${r.validity.value}`)
                        ? t(`validity.${r.validity.value}` as MessageKey)
                        : r.validity.value
                    }
                    signal={r.validity}
                  />
                  <SignalRow
                    label={t('signal.funds')}
                    value={fundsLine(i18n, item)}
                    signal={r.funds}
                  />
                  <SignalRow
                    label={t('signal.expiry')}
                    value={r.expiry.value.expires_at ? i18n.date(r.expiry.value.expires_at) : '—'}
                    signal={r.expiry}
                  />
                  {r.limits && (
                    <SignalRow
                      label={t('signal.limits')}
                      value={limitsLine(i18n, item) ?? r.limits.value.state}
                      signal={r.limits}
                    />
                  )}
                  {r.last_used_at && (
                    <SignalRow
                      label={t('lastUsed', { when: '' }).trim()}
                      value={i18n.relative(r.last_used_at.value, now)}
                      signal={r.last_used_at}
                    />
                  )}
                </dl>
                {fundsInfoLine(i18n, item) && (
                  <p className="mt-2 text-muted-foreground text-xs" data-testid="funds-info">
                    {fundsInfoLine(i18n, item)}
                  </p>
                )}
                {item.credential.parent_id && (
                  <p className="mt-1 text-muted-foreground text-xs">{t('reportedBy')}</p>
                )}
              </section>

              {Object.keys(r.account).length > 0 && (
                <section>
                  <h3 className="mb-1 font-medium text-sm">{t('account')}</h3>
                  <dl className="divide-y">
                    {Object.entries(r.account).map(([key, signal]) => (
                      <SignalRow key={key} label={key} value={signal.value} signal={signal} />
                    ))}
                  </dl>
                </section>
              )}

              <ExposuresSection
                credential={item.credential}
                api={api}
                now={now}
                paused={deleting}
              />

              {r.error && (
                <section>
                  <h3 className="mb-1 font-medium text-sm">{t('error')}</h3>
                  <p className="font-mono text-xs">
                    {r.error.code}: {r.error.message}
                  </p>
                </section>
              )}

              <section>
                <h3 className="mb-2 font-medium text-sm">{t('history')}</h3>
                <ol className="flex flex-wrap gap-1" aria-label={t('history')}>
                  {points.map((p) => (
                    <li
                      key={p.checked_at}
                      title={`${i18n.date(p.checked_at)} · ${t(`status.${p.overall}`)}`}
                      className={cn('size-3 rounded-sm', STATUS[p.overall].dot)}
                    >
                      <span className="sr-only">
                        {i18n.relative(p.checked_at, now)}: {t(`status.${p.overall}`)}
                      </span>
                    </li>
                  ))}
                </ol>
                {latency.length > 1 && (
                  <div className="mt-3">
                    <p className="mb-1 text-muted-foreground text-xs">
                      {t('latency')}:{' '}
                      {t('latencyMs', { ms: Math.round(latency[latency.length - 1]?.ms ?? 0) })}
                    </p>
                    <ChartContainer
                      config={{ ms: { label: t('latency'), color: 'var(--chart-1)' } }}
                      className="h-16 w-full"
                    >
                      <LineChart data={latency} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                        <YAxis hide domain={['dataMin', 'dataMax']} />
                        <Line
                          dataKey="ms"
                          type="monotone"
                          stroke="var(--color-ms)"
                          strokeWidth={1.5}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ChartContainer>
                  </div>
                )}
              </section>

              {item.credential.provider === 'openai' && item.credential.kind === 'admin_key' && (
                <form
                  className="space-y-2 rounded-md border p-3"
                  data-testid="budget-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    saveBudget.mutate()
                  }}
                >
                  <h3 className="font-medium text-sm">{t('budget')}</h3>
                  {STATIC_DEMO && (
                    <p className="text-muted-foreground text-xs" data-testid="static-disabled">
                      {t('staticNotAvailable')}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">{t('budgetHint')}</p>
                  <p className="text-amber-700 text-xs dark:text-amber-300">
                    {t('budgetAutoRecharge')}
                  </p>
                  <fieldset disabled={STATIC_DEMO} className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor={`${formId}-budget`}>{t('budgetAmount')}</Label>
                      <Input
                        id={`${formId}-budget`}
                        inputMode="decimal"
                        value={budgetAmount}
                        onChange={(e) => setBudgetAmount(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${formId}-budget-date`}>{t('budgetDate')}</Label>
                      <Input
                        id={`${formId}-budget-date`}
                        type="date"
                        value={budgetDate}
                        onChange={(e) => setBudgetDate(e.target.value)}
                      />
                    </div>
                  </fieldset>
                  <fieldset disabled={STATIC_DEMO} className="flex gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!budgetAmount || !budgetDate || saveBudget.isPending}
                    >
                      {t('save')}
                    </Button>
                    {item.credential.manual_budget && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => clearBudget.mutate()}
                      >
                        {t('clear')}
                      </Button>
                    )}
                  </fieldset>
                </form>
              )}

              <details className="text-sm">
                <summary className="cursor-pointer font-medium">{t('responseHeaders')}</summary>
                {r.http && Object.keys(r.http.headers).length > 0 ? (
                  <dl className="mt-2 space-y-1 font-mono text-xs">
                    {Object.entries(r.http.headers).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="break-all">{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-2 text-muted-foreground text-xs">{t('noHeaders')}</p>
                )}
              </details>

              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  save.mutate()
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor={`${formId}-label`}>{t('label')}</Label>
                  <Input
                    id={`${formId}-label`}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${formId}-tags`}>{t('tags')}</Label>
                  <Input
                    id={`${formId}-tags`}
                    value={tags}
                    aria-describedby={`${formId}-tags-hint`}
                    onChange={(e) => setTags(e.target.value)}
                  />
                  <p id={`${formId}-tags-hint`} className="text-muted-foreground text-xs">
                    {t('tagsHint')}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${formId}-expiry`}>{t('manualExpiry')}</Label>
                  <Input
                    id={`${formId}-expiry`}
                    type="date"
                    disabled={STATIC_DEMO}
                    aria-describedby={STATIC_DEMO ? `${formId}-expiry-static` : undefined}
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                  />
                  {STATIC_DEMO && (
                    <p id={`${formId}-expiry-static`} className="text-muted-foreground text-xs">
                      {t('staticNotAvailable')}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${formId}-notes`}>{t('notes')}</Label>
                  <Textarea
                    id={`${formId}-notes`}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
                <div className="flex justify-between gap-2">
                  <Button type="submit" disabled={save.isPending}>
                    {t('save')}
                  </Button>
                  <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                    <AlertDialogTrigger asChild>
                      <Button type="button" variant="destructive" disabled={remove.isPending}>
                        {t('delete')}
                      </Button>
                    </AlertDialogTrigger>
                    {/* Radix focuses Cancel when it opens: deleting takes a deliberate move. */}
                    <AlertDialogContent data-testid="delete-dialog">
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t('deleteTitle', { label: item.credential.label })}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          <span className="block font-mono">{item.credential.redacted}</span>
                          {t('deleteConfirm')}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
                          {t('delete')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </form>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
