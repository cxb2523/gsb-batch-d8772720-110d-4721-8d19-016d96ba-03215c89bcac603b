import { useEffect, useState } from 'react'
import { Footer } from '@/components/mecha/Footer'
import { Button } from '@/components/ui/button'
import { Dashboard } from '@/Dashboard'
import { useI18n } from '@/i18n'
import { makeApi } from '@/lib/api'
import { StaticBanner } from '@/lib/edition'
import { ApiError } from '@/lib/errors'
import { initSessionToken } from '@/lib/session'

type Health = { status: 'ok'; version: string; demo: boolean }

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; health: Health }
  | { kind: 'locked' }
  | { kind: 'error'; message: string }

export function App({ token = initSessionToken() }: { token?: string | null }) {
  const { t } = useI18n()
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the check on retry.
  useEffect(() => {
    if (!token) {
      setState({ kind: 'locked' })
      return
    }
    let cancelled = false
    makeApi(token)
      .health()
      .then((health) => !cancelled && setState({ kind: 'ready', health }))
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 401) setState({ kind: 'locked' })
        else setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [token, attempt])

  if (state.kind === 'ready' && token) {
    return (
      <>
        {StaticBanner && <StaticBanner />}
        <Dashboard token={token} />
        <Footer />
      </>
    )
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-4 p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Mecha</h1>
      {state.kind === 'loading' && <p className="text-muted-foreground">…</p>}
      {state.kind === 'locked' && (
        <div role="alert" className="space-y-2">
          <p className="font-medium">{t('locked')}</p>
          <p className="text-muted-foreground text-sm">{t('lockedHint')}</p>
        </div>
      )}
      {state.kind === 'error' && (
        <div role="alert" className="space-y-2">
          <p className="font-medium">{t('unreachable')}</p>
          <p className="text-muted-foreground text-sm">{state.message}</p>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            {t('retry')}
          </Button>
        </div>
      )}
    </main>
  )
}
