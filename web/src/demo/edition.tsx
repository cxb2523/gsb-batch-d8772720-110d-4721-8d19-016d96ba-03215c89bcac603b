import { Check, Copy, KeyRound } from 'lucide-react'
import { useId, useState } from 'react'
import { providerName } from '@/components/mecha/text'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import type * as Normal from '@/lib/edition'
import type { SamplePickerProps } from '@/lib/edition'
import { RAW } from './data'

export const STATIC_DEMO: boolean = true

const INSTALL = 'uvx mecha-keys'

function StaticBannerImpl() {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const id = useId()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard blocked: the command is on screen anyway
    }
  }
  return (
    <aside
      aria-labelledby={id}
      data-testid="static-banner"
      className="sticky top-0 z-40 border-amber-500/40 border-b bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-50"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
        <span id={id} className="font-medium">
          {t('staticBanner')}
        </span>
        <span className="flex items-center gap-2">
          {t('staticBannerInstall')}
          <code className="rounded bg-black/10 px-1.5 py-0.5 font-mono dark:bg-white/10">
            {INSTALL}
          </code>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={copied ? t('copied') : t('copyCommand')}
            onClick={copy}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </span>
      </div>
    </aside>
  )
}

function SamplePickerImpl({ onPick, pending }: SamplePickerProps) {
  const { t } = useI18n()
  return (
    <div className="space-y-3" data-testid="sample-picker">
      <p className="text-muted-foreground text-sm">{t('samplePickHint')}</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {RAW.samples.map((s) => (
          <li key={s.id}>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              className="h-auto w-full justify-start gap-3 py-2 text-left"
              onClick={() => onPick(`sample:${s.id}`, s.label)}
            >
              <KeyRound aria-hidden className="shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {providerName(s.provider)} · {t(`kind.${s.kind}`)}
                </span>
                <span className="block truncate font-mono text-muted-foreground text-xs">
                  {s.redacted}
                </span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export const SamplePicker: typeof Normal.SamplePicker = SamplePickerImpl
export const StaticBanner: typeof Normal.StaticBanner = StaticBannerImpl
