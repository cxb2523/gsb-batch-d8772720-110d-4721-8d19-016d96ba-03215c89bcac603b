import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'
import type { Api } from '@/lib/api'
import { SamplePicker } from '@/lib/edition'
import { ApiError } from '@/lib/errors'
import type { Detection, Kind, ProviderInfo } from '@/lib/types'
import { EnvImportPanel, LinkPanel } from './ImportPanels'
import { ScanPanel } from './ScanPanel'
import { useToast } from './Toaster'
import { providerName } from './text'

const KINDS: Kind[] = ['api_key', 'admin_key', 'management_key']
const DEBOUNCE_MS = 300

/**
 * Add a credential. The secret lives only in this component's state: detection is a
 * mutation (never a query keyed by the secret, which would sit in the cache and the
 * devtools), and everything is wiped when the dialog closes.
 */
export function AddDialog({
  open,
  onOpenChange,
  api,
  providers,
  demo,
  onOpenCredential,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  api: Api
  providers: ProviderInfo[]
  demo: boolean
  /** Close this dialog and open a stored credential's sheet (from a scan finding). */
  onOpenCredential?: (id: string) => void
}) {
  const { t } = useI18n()
  const toast = useToast()
  const qc = useQueryClient()
  const id = useId()
  const [secret, setSecret] = useState('')
  const [label, setLabel] = useState('')
  const [tags, setTags] = useState('')
  const [expiry, setExpiry] = useState('')
  const [provider, setProvider] = useState('')
  const [kind, setKind] = useState('')
  const abort = useRef<AbortController | null>(null)

  const detect = useMutation<Detection, Error, string>({
    mutationFn: (value) => {
      abort.current?.abort()
      abort.current = new AbortController()
      return api.detect(value, abort.current.signal)
    },
    gcTime: 0,
  })
  const add = useMutation({
    mutationFn: () =>
      api.add({
        secret,
        label: label || undefined,
        tags: tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        provider: provider || undefined,
        kind: kind || undefined,
        manual_expires_at: expiry ? `${expiry}T00:00:00Z` : null,
      }),
    gcTime: 0,
    onSuccess: (item) => {
      toast(t('added', { label: item.credential.label }))
      void qc.invalidateQueries({ queryKey: ['credentials'] })
      onOpenChange(false)
    },
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })

  // Web demo: pick a sample key (there is no field to paste one).
  const pick = useMutation({
    mutationFn: ({ value, label }: { value: string; label: string }) =>
      api.add({ secret: value, label }),
    onSuccess: (item) => {
      toast(t('added', { label: item.credential.label }))
      void qc.invalidateQueries({ queryKey: ['credentials'] })
      onOpenChange(false)
    },
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })

  // Debounced live detection.
  const { mutate: runDetect, reset: resetDetect } = detect
  useEffect(() => {
    if (!secret.trim()) {
      resetDetect()
      return
    }
    const timer = setTimeout(() => runDetect(secret), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [secret, runDetect, resetDetect])

  // Wipe everything on close.
  const { reset: resetAdd } = add
  useEffect(() => {
    if (open) return
    abort.current?.abort()
    setSecret('')
    setLabel('')
    setTags('')
    setExpiry('')
    setProvider('')
    setKind('')
    resetDetect()
    resetAdd()
  }, [open, resetDetect, resetAdd])

  const det = detect.data
  const caps = providers.find((p) => p.id === (provider || det?.provider))
  const needsProvider = det && (det.format === 'unknown' || det.ambiguous || det.provider === null)
  const blocked = det && det.format !== 'unknown' && !det.storable
  const err = add.error instanceof ApiError ? add.error : null

  if (SamplePicker) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="add-dialog" className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('addTitle')}</DialogTitle>
            <DialogDescription>{t('staticBanner')}</DialogDescription>
          </DialogHeader>
          {/* No field to paste anything: sample keys, and the demo's recorded scan. */}
          <Tabs defaultValue="samples">
            <TabsList>
              <TabsTrigger value="samples">{t('tabSamples')}</TabsTrigger>
              <TabsTrigger value="scan">{t('tabScan')}</TabsTrigger>
            </TabsList>
            <TabsContent value="samples">
              <SamplePicker
                pending={pick.isPending}
                onPick={(value, sampleLabel) => pick.mutate({ value, label: sampleLabel })}
              />
            </TabsContent>
            <TabsContent value="scan">
              <ScanPanel
                api={api}
                onDone={() => onOpenChange(false)}
                onOpenCredential={onOpenCredential}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-dialog" className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('addTitle')}</DialogTitle>
          <DialogDescription>
            {t('secretHint')}
            {demo && (
              <span className="mt-1 block text-amber-700 dark:text-amber-300">
                {t('demoAddHint')}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="secret">
          <TabsList>
            <TabsTrigger value="secret">{t('tabSecret')}</TabsTrigger>
            <TabsTrigger value="env">{t('tabEnv')}</TabsTrigger>
            <TabsTrigger value="link">{t('tabLink')}</TabsTrigger>
            <TabsTrigger value="scan">{t('tabScan')}</TabsTrigger>
          </TabsList>
          <TabsContent value="secret" className="space-y-3">
            <form
              id={`${id}-form`}
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (secret.trim() && !blocked) add.mutate()
              }}
            >
              <div className="space-y-1">
                <Label htmlFor={`${id}-secret`}>{t('secret')}</Label>
                <Input
                  id={`${id}-secret`}
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  aria-describedby={`${id}-detected`}
                  className="font-mono"
                />
                <p id={`${id}-detected`} className="min-h-5 text-xs" aria-live="polite">
                  {detect.isPending && t('detecting')}
                  {det && det.format !== 'unknown' && det.provider && det.kind && (
                    <>
                      {t('detected', {
                        provider: providerName(det.provider),
                        kind: t(`kind.${det.kind}`),
                      })}
                      {!det.verified && (
                        <span className="text-muted-foreground"> · {t('formatUnverified')}</span>
                      )}
                    </>
                  )}
                  {det?.format === 'unknown' && t('unknownFormat')}
                  {det?.ambiguous && ` ${t('ambiguousProvider')}`}
                  {det?.format === 'session_file' && t('sessionFile')}
                  {blocked && det?.format !== 'session_file' && t('refreshToken')}
                </p>
                {caps && (
                  <p className="text-muted-foreground text-xs">
                    {t('canKnow', {
                      validate: t(`cap.${caps.validate}`),
                      funds: t(`cap.${caps.funds}`),
                      expiry: t(`cap.${caps.expiry}`),
                    })}
                  </p>
                )}
              </div>
              {needsProvider && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-provider`}>{t('provider')}</Label>
                    <select
                      id={`${id}-provider`}
                      className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      <option value="">—</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-kind`}>{t('kind')}</Label>
                    <select
                      id={`${id}-kind`}
                      className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                      value={kind}
                      onChange={(e) => setKind(e.target.value)}
                    >
                      <option value="">—</option>
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {t(`kind.${k}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor={`${id}-label`}>{t('label')}</Label>
                <Input
                  id={`${id}-label`}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor={`${id}-tags`}>{t('tags')}</Label>
                  <Input
                    id={`${id}-tags`}
                    value={tags}
                    placeholder={t('tagsHint')}
                    onChange={(e) => setTags(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-expiry`}>{t('manualExpiry')}</Label>
                  <Input
                    id={`${id}-expiry`}
                    type="date"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                  />
                </div>
              </div>
              {err && (
                <p role="alert" className="text-red-600 text-sm dark:text-red-400">
                  {err.message}
                </p>
              )}
            </form>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                form={`${id}-form`}
                disabled={!secret.trim() || add.isPending || !!blocked}
              >
                {t('add')}
              </Button>
            </DialogFooter>
          </TabsContent>
          <TabsContent value="env">
            <EnvImportPanel api={api} onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="scan">
            <ScanPanel
              api={api}
              onDone={() => onOpenChange(false)}
              onOpenCredential={onOpenCredential}
            />
          </TabsContent>
          <TabsContent value="link">
            <LinkPanel api={api} onDone={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
