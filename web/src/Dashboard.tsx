import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Languages, LayoutGrid, Moon, Plus, Search, Sun, Table2 } from 'lucide-react'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Counters } from '@/components/mecha/Counters'
import { CredentialCard } from '@/components/mecha/CredentialCard'
import { CredentialTable } from '@/components/mecha/CredentialTable'
import { useToast } from '@/components/mecha/Toaster'
import { providerName } from '@/components/mecha/text'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useI18n, useSetLang } from '@/i18n'
import { makeApi } from '@/lib/api'
import { connectEvents } from '@/lib/events'
import { SCAN_KEY, SCAN_PROGRESS_KEY, type ScanProgress } from '@/lib/scan'
import { type EventPosition, missedEvents } from '@/lib/sync'
import { type CredentialStatus, DEFAULT_SETTINGS, OVERALL_ORDER, type Overall } from '@/lib/types'

// Loaded on first use: the detail sheet carries the chart library, which the first paint
// does not need.
const DetailSheet = lazy(() =>
  import('@/components/mecha/DetailSheet').then((m) => ({ default: m.DetailSheet })),
)
const AddDialog = lazy(() =>
  import('@/components/mecha/AddDialog').then((m) => ({ default: m.AddDialog })),
)
const CommandPalette = lazy(() =>
  import('@/components/mecha/CommandPalette').then((m) => ({ default: m.CommandPalette })),
)

type View = 'cards' | 'table'
const EMPTY: CredentialStatus[] = []

function stored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = window.localStorage.getItem(key) as T | null
    return v && allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}

function persist(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // storage blocked: preference lasts for this page only
  }
}

function setTheme(theme: 'dark' | 'light') {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
  root.style.colorScheme = theme
  persist('mecha.theme', theme)
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

export function Dashboard({ token }: { token: string }) {
  const i18n = useI18n()
  const setLang = useSetLang()
  const { t } = i18n
  const toast = useToast()
  const qc = useQueryClient()
  const api = useMemo(() => makeApi(token), [token])

  // One request for the whole dashboard; history is loaded only by the detail sheet.
  // Kept fresh even without events: a `mecha check` from cron does not go through the
  // event bus, and a key can expire while the tab is open.
  const listing = useQuery({
    queryKey: ['credentials'],
    queryFn: api.list,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  })
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: api.providers,
    staleTime: Number.POSITIVE_INFINITY,
  })

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [view, setView] = useState<View>(() =>
    stored('mecha.view', 'cards', ['cards', 'table'] as const),
  )
  const [theme, setThemeState] = useState<'dark' | 'light'>(() =>
    document.documentElement.classList.contains('light') ? 'light' : 'dark',
  )
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Overall | null>(null)
  const [provider, setProvider] = useState('')
  const [kind, setKind] = useState('')
  const [tag, setTag] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Server events only invalidate queries. Each stream (first open or reconnect) starts
  // with `hello` and the bus position; everything is reloaded only if the listing is from
  // before it (events were missed) or from another server start: never otherwise.
  const listingAt = useRef<EventPosition | undefined>(undefined)
  const helloAt = useRef<EventPosition | undefined>(undefined)
  const syncIfMissed = useCallback(() => {
    if (missedEvents(listingAt.current, helloAt.current)) {
      helloAt.current = undefined // one reload per hello
      void qc.invalidateQueries()
    }
  }, [qc])
  const listingEvents = listing.data?.events
  useEffect(() => {
    listingAt.current = listingEvents
    syncIfMissed() // a listing that arrives after the hello is compared too
  }, [listingEvents, syncIfMissed])

  useEffect(() => {
    const controller = new AbortController()
    void connectEvents({
      token,
      signal: controller.signal,
      onEvent: (type, data) => {
        if (type === 'hello') {
          helloAt.current = data as EventPosition
          syncIfMissed()
          return
        }
        if (type.startsWith('scan_')) {
          // Progress arrives up to 4 times a second: it updates the scan tab only, never
          // the listing (a scan that changes stored keys sends credentials_changed).
          const s = (data ?? {}) as { files?: number; cancelled?: boolean; failed?: boolean }
          const outcome =
            type === 'scan_done'
              ? s.cancelled
                ? 'cancelled'
                : s.failed
                  ? 'failed'
                  : 'done'
              : 'running'
          qc.setQueryData<ScanProgress>(SCAN_PROGRESS_KEY, (old) => ({
            files: s.files ?? old?.files ?? 0,
            outcome,
          }))
          if (type !== 'scan_progress') void qc.invalidateQueries({ queryKey: SCAN_KEY })
          return
        }
        const d = (data ?? {}) as { done?: number; total?: number }
        if (type === 'check_all_started') setProgress({ done: 0, total: d.total ?? 0 })
        if (type === 'check_progress') setProgress({ done: d.done ?? 0, total: d.total ?? 0 })
        if (type === 'check_all_done') setProgress(null)
        void qc.invalidateQueries({ queryKey: ['credentials'] })
        if (type !== 'check_progress') {
          void qc.invalidateQueries({ queryKey: ['history'] })
          void qc.invalidateQueries({ queryKey: ['exposures'] })
        }
      },
    })
    return () => controller.abort()
  }, [token, qc, syncIfMissed])

  const checkAll = useMutation({
    mutationFn: api.checkAll,
    onSuccess: (r) => {
      setProgress({ done: 0, total: r.total })
      toast(t('checkAllStarted', { count: i18n.plural('plural.credential', r.total) }))
    },
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  const checkOne = useCallback(
    (id: string) => {
      setChecking((s) => new Set(s).add(id))
      api
        .check(id)
        .catch((e: Error) => toast(t('failed', { message: e.message }), 'error'))
        .finally(() => {
          setChecking((s) => {
            const next = new Set(s)
            next.delete(id)
            return next
          })
          void qc.invalidateQueries({ queryKey: ['credentials'] })
        })
    },
    [api, qc, t, toast],
  )

  const data = listing.data
  const items = data?.credentials ?? EMPTY
  const now = data?.generated_at ?? new Date().toISOString()
  const horizonDays = (data?.settings ?? DEFAULT_SETTINGS).fuse_horizon_days

  const counts = useMemo(() => {
    const c: Record<Overall, number> = { green: 0, amber: 0, red: 0, grey: 0, local: 0 }
    for (const i of items) c[i.result.overall] += 1
    return c
  }, [items])
  const allTags = useMemo(
    () => [...new Set(items.flatMap((i) => i.credential.tags))].sort(),
    [items],
  )
  const lastGlobal = useMemo(() => {
    const times = items.filter((i) => i.result.mode !== 'offline').map((i) => i.result.checked_at)
    return times.length ? times.sort().at(-1) : null
  }, [items])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((i) => {
      const c = i.credential
      if (status && i.result.overall !== status) return false
      if (provider && c.provider !== provider) return false
      if (kind && c.kind !== kind) return false
      if (tag && !c.tags.includes(tag)) return false
      if (!q) return true
      return [c.label, c.redacted, c.provider, ...c.tags].some((s) => s.toLowerCase().includes(q))
    })
  }, [items, query, status, provider, kind, tag])
  // Server order is already red > amber > grey > local > green, soonest expiry first.
  const ordered = useMemo(
    () =>
      [...filtered].sort(
        (a, b) => OVERALL_ORDER.indexOf(a.result.overall) - OVERALL_ORDER.indexOf(b.result.overall),
      ),
    [filtered],
  )

  // Performance mark when every card is painted (measured by the Playwright smoke test).
  const marked = useRef(false)
  useLayoutEffect(() => {
    if (marked.current || !data) return
    marked.current = true
    requestAnimationFrame(() =>
      performance.mark('mecha:cards-rendered', { detail: { count: items.length } }),
    )
  }, [data, items.length])

  // Keyboard: ⌘K / Ctrl+K palette, N add, / search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        setAddOpen(true)
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    setThemeState(next)
  }
  const changeView = (v: View) => {
    setView(v)
    persist('mecha.view', v)
  }

  const selectedItem = items.find((i) => i.credential.id === selected) ?? null
  const providerList = providers.data?.providers ?? []
  const probes = Object.fromEntries(providerList.map((p) => [p.id, p.probe]))

  return (
    <div className="min-h-svh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded focus:bg-background focus:px-3 focus:py-2"
      >
        {t('skipToContent')}
      </a>
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <h1 className="font-semibold text-lg tracking-tight">Mecha</h1>
            {data?.demo && (
              <Badge
                data-testid="demo-badge"
                className="bg-amber-500 text-black hover:bg-amber-500"
              >
                {t('demoBadge')}
              </Badge>
            )}
            <span className="hidden text-muted-foreground text-sm md:inline">
              {t('appTagline')}
            </span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs" data-testid="last-global">
              {lastGlobal
                ? t('lastGlobalCheck', { when: i18n.relative(lastGlobal, now) })
                : t('neverChecked')}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => checkAll.mutate()}
              disabled={progress !== null || checkAll.isPending}
              aria-describedby="check-progress"
            >
              {t('checkAll')}
            </Button>
            <span
              id="check-progress"
              role="status"
              aria-live="polite"
              className="min-w-24 text-xs tabular-nums"
            >
              {progress && t('checkingProgress', { done: progress.done, total: progress.total })}
            </span>
            <Button size="sm" onClick={() => setAddOpen(true)} aria-keyshortcuts="n">
              <Plus aria-hidden="true" />
              {t('addCredential')}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={toggleTheme}
              aria-label={`${t('theme')}: ${theme === 'dark' ? t('themeLight') : t('themeDark')}`}
            >
              {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="lang-toggle"
              lang={i18n.lang === 'es' ? 'en' : 'es'}
              onClick={() => setLang(i18n.lang === 'es' ? 'en' : 'es')}
              // The name contains the visible code (voice control) and the language's own name.
              aria-label={i18n.lang === 'es' ? 'EN · English' : 'ES · Español'}
            >
              <Languages aria-hidden="true" />
              {i18n.lang === 'es' ? 'EN' : 'ES'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPaletteOpen(true)}
              aria-keyshortcuts="Meta+K Control+K"
            >
              <kbd className="font-mono text-xs">⌘K</kbd>
              <span className="sr-only">{t('commandPalette')}</span>
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-7xl space-y-4 px-4 py-4">
        <Counters
          counts={counts}
          active={status}
          onToggle={(o) => setStatus((s) => (s === o ? null : o))}
        />

        <search className="flex flex-wrap items-end gap-3">
          <div className="relative min-w-56 flex-1">
            <label htmlFor="search" className="sr-only">
              {t('search')}
            </label>
            <Search
              aria-hidden="true"
              className="-translate-y-1/2 absolute top-1/2 left-2 size-4 text-muted-foreground"
            />
            <Input
              id="search"
              ref={searchRef}
              type="search"
              placeholder={t('searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
              aria-keyshortcuts="/"
            />
          </div>
          {(
            [
              [
                'provider',
                t('filterProvider'),
                provider,
                setProvider,
                [...new Set(items.map((i) => i.credential.provider))].map((p) => [
                  p,
                  providerName(p),
                ]),
              ],
              [
                'kind',
                t('filterKind'),
                kind,
                setKind,
                [...new Set(items.map((i) => i.credential.kind))].map((k) => [k, t(`kind.${k}`)]),
              ],
              ['tag', t('filterTag'), tag, setTag, allTags.map((x) => [x, x])],
            ] as const
          ).map(([key, label, value, set, options]) => (
            <div key={key} className="space-y-1">
              <label htmlFor={`filter-${key}`} className="block text-muted-foreground text-xs">
                {label}
              </label>
              <select
                id={`filter-${key}`}
                className="h-8 rounded-md border bg-background px-2 text-sm"
                value={value}
                onChange={(e) => set(e.target.value)}
              >
                <option value="">{t('allOption')}</option>
                {options.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(v) => v && changeView(v as View)}
            variant="outline"
            size="sm"
            aria-label={`${t('viewCards')} / ${t('viewTable')}`}
          >
            <ToggleGroupItem value="cards" aria-label={t('viewCards')}>
              <LayoutGrid aria-hidden="true" />
            </ToggleGroupItem>
            <ToggleGroupItem value="table" aria-label={t('viewTable')}>
              <Table2 aria-hidden="true" />
            </ToggleGroupItem>
          </ToggleGroup>
        </search>

        {listing.isError && (
          <p role="alert" className="text-red-600 text-sm">
            {t('failed', { message: (listing.error as Error).message })}
          </p>
        )}
        {data && items.length === 0 && <p className="text-muted-foreground">{t('empty')}</p>}
        {data && items.length > 0 && ordered.length === 0 && (
          <p className="text-muted-foreground">{t('emptyFiltered')}</p>
        )}

        {view === 'cards' ? (
          <section
            aria-label={i18n.plural('plural.credential', ordered.length)}
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="cards"
          >
            {ordered.map((item) => (
              <CredentialCard
                key={item.credential.id}
                item={item}
                now={now}
                horizonDays={horizonDays}
                probe={probes[item.credential.provider] ?? null}
                api={api}
                onOpen={setSelected}
                onCheck={checkOne}
                checking={checking.has(item.credential.id) || progress !== null}
              />
            ))}
          </section>
        ) : (
          <CredentialTable
            items={ordered}
            now={now}
            horizonDays={horizonDays}
            onOpen={setSelected}
          />
        )}
      </main>

      <Suspense fallback={null}>
        {selectedItem && (
          <DetailSheet
            item={selectedItem}
            now={now}
            horizonDays={horizonDays}
            api={api}
            probe={probes[selectedItem.credential.provider] ?? null}
            onClose={() => setSelected(null)}
          />
        )}
        {addOpen && (
          <AddDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            api={api}
            providers={providerList}
            demo={!!data?.demo}
            onOpenCredential={(cid) => {
              setAddOpen(false)
              setSelected(cid)
            }}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            items={ordered}
            onOpen={setSelected}
            actions={[
              { id: 'check-all', label: t('checkAll'), run: () => checkAll.mutate() },
              { id: 'add', label: t('addCredential'), run: () => setAddOpen(true) },
              {
                id: 'theme',
                label: `${t('theme')}: ${theme === 'dark' ? t('themeLight') : t('themeDark')}`,
                run: toggleTheme,
              },
              {
                id: 'view',
                label: view === 'cards' ? t('viewTable') : t('viewCards'),
                run: () => changeView(view === 'cards' ? 'table' : 'cards'),
              },
            ]}
          />
        )}
      </Suspense>
    </div>
  )
}
