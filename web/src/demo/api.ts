/**
 * In-memory stand-in for `lib/api` in the web demo (GitHub Pages). Same interface as the
 * real `makeApi`, but no network at all: it replays the answers that `mecha serve --demo`
 * gave to the same requests (scripts/dump_demo.py) and keeps edits in this page only.
 *
 * It never computes a state itself: anything that would need the Python state engine
 * (a manual expiry, an OpenAI budget) is disabled in the UI and refused here.
 */
import type { Api, CredentialPatch, NewCredential } from '@/lib/api'
import { ApiError } from '@/lib/errors'
import type { CheckResult, CredentialStatus, ScanReport } from '@/lib/types'
import { emit } from './bus'
import { type Answer, loadDemoData, type Sample, type ScanImport } from './data'

export const NOT_AVAILABLE = 'not_available_in_demo'
const PROBE_INTERVAL_MS = 60 * 60 * 1000
const CHECK_ALL_STEP_MS = 120
const SCAN_STEPS = 20
const SCAN_STEP_MS = 75 // 1.5 s, like `mecha serve --demo`
const SCAN_TTL_MS = 30 * 60 * 1000

declare const __MECHA_VERSION__: string

const notAvailable = (what: string) =>
  Promise.reject(
    new ApiError(
      422,
      NOT_AVAILABLE,
      `${what} is not available in the web demo. Install Mecha to use it: uvx mecha-keys`,
    ),
  )

const clone = <T>(value: T): T => structuredClone(value)

/** The demo's state for this page load. */
function createState(now: () => number) {
  const data = loadDemoData(now())
  const items = new Map<string, CredentialStatus>(
    data.listing.credentials.map((item) => [item.credential.id, item]),
  )
  const history = new Map<string, CheckResult[]>(Object.entries(data.history))
  const samples = new Map<string, Sample>(data.samples.map((s) => [s.id, s]))
  const sampleOf = new Map<string, Sample>() // credential id -> sample it came from
  const edits = new Map<string, Partial<CredentialStatus['credential']>>()
  const importedOf = new Map<string, ScanImport>() // credential id -> scan finding import
  const scan = { running: false, stop: false, report: null as ScanReport | null }
  return { data, items, history, samples, sampleOf, edits, importedOf, scan }
}

export function makeApi(_token: string | null, now: () => number = Date.now): Api {
  const state = createState(now)

  const get = (id: string): CredentialStatus => {
    const item = state.items.get(id)
    if (!item) throw new ApiError(404, 'not_found', 'No such credential.')
    return item
  }

  /** Apply a recorded answer to a credential, keeping this page's edits (label, tags…). */
  const apply = (id: string, answer: Answer | undefined, mode: 'check' | 'probe') => {
    if (!answer) throw new ApiError(400, 'not_supported', 'Not supported for this credential.')
    if (answer.status >= 400) {
      const err = answer.body as { code?: string; message?: string }
      throw new ApiError(answer.status, err.code ?? 'http_error', err.message ?? 'Error')
    }
    const body = clone(answer.body as CredentialStatus)
    const at = new Date(now()).toISOString()
    const result = { ...body.result, checked_at: at }
    const item: CredentialStatus = {
      ...body,
      result,
      cached: false,
      credential: { ...body.credential, ...state.edits.get(id) },
      probe_next_at:
        mode === 'probe'
          ? new Date(now() + PROBE_INTERVAL_MS).toISOString()
          : (state.items.get(id)?.probe_next_at ?? body.probe_next_at),
    }
    state.items.set(id, item)
    state.history.set(id, [result, ...(state.history.get(id) ?? [])])
    return clone(item)
  }

  const answerFor = (id: string, mode: 'check' | 'probe'): Answer | undefined => {
    const sample = state.sampleOf.get(id) ?? state.importedOf.get(id)
    if (sample) return sample[mode]
    return state.data[mode][id]
  }

  const check = async (id: string): Promise<CredentialStatus> => {
    get(id)
    return apply(id, answerFor(id, 'check'), 'check')
  }

  return {
    health: async () => ({ status: 'ok' as const, version: __MECHA_VERSION__, demo: true }),

    list: async () => ({
      ...clone(state.data.listing),
      generated_at: new Date(now()).toISOString(),
      credentials: [...state.items.values()].map(clone),
    }),

    providers: async () => clone(state.data.providers),

    history: async (id: string, limit = 50) => ({
      history: clone((state.history.get(id) ?? []).slice(0, limit)),
    }),

    // No free text field in the web demo: nothing to detect.
    detect: (_secret: string, _signal?: AbortSignal) => notAvailable('Detecting a pasted key'),

    /** Only the sample keys offered by "Add" (`sample:<id>`), never a pasted secret. */
    add: async (body: NewCredential) => {
      const sample = body.secret.startsWith('sample:')
        ? state.samples.get(body.secret.slice('sample:'.length))
        : undefined
      if (!sample) return notAvailable('Adding your own keys')
      const id = sample.added.credential.id
      if (state.items.has(id)) {
        throw new ApiError(409, 'duplicate', `This credential is already stored as ${id}.`)
      }
      const item = clone(sample.added)
      if (body.label) item.credential.label = body.label
      state.items.set(id, item)
      state.sampleOf.set(id, sample)
      state.history.set(id, [])
      return clone(item)
    },

    patch: async (id: string, body: CredentialPatch) => {
      const item = get(id)
      if (body.manual_budget !== undefined) return notAvailable('Setting a budget')
      // A manual expiry would need the state engine; the field is disabled in the UI.
      const edit = {
        ...state.edits.get(id),
        ...(body.label !== undefined && { label: body.label }),
        ...(body.tags !== undefined && { tags: body.tags }),
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.active_probe !== undefined && { active_probe: body.active_probe }),
      }
      state.edits.set(id, edit)
      const updated = { ...item, credential: { ...item.credential, ...edit } }
      state.items.set(id, updated)
      return clone(updated)
    },

    remove: async (id: string) => {
      state.items.delete(id)
      state.history.delete(id)
      return null
    },

    check: (id: string, _force = true) => check(id),

    checkAll: async () => {
      const ids = [...state.items.keys()]
      const total = ids.length
      // Like the server: answer at once, then report progress over the event stream.
      setTimeout(async () => {
        emit('check_all_started', { total })
        for (const [index, id] of ids.entries()) {
          await new Promise((r) => setTimeout(r, CHECK_ALL_STEP_MS))
          if (!state.items.has(id)) continue
          try {
            await check(id)
          } catch {
            // a failed check is part of the result, as on the server
          }
          emit('check_progress', { id, done: index + 1, total })
        }
        emit('check_all_done', { total })
      }, 0)
      return { started: true, total }
    },

    /** Same hourly limit as the server: 409 probe_too_soon unless confirmed with `force`. */
    probe: async (id: string, force = false) => {
      const item = get(id)
      const next = item.probe_next_at ? Date.parse(item.probe_next_at) : 0
      if (!force && next > now()) {
        throw new ApiError(409, 'probe_too_soon', 'The last probe was less than an hour ago.')
      }
      return apply(id, answerFor(id, 'probe'), 'probe')
    },

    envPreview: (_content: string) => notAvailable('Importing a .env file'),
    envImport: (_content: string, _select: number[], _providers: Record<number, string> = {}) =>
      notAvailable('Importing a .env file'),
    linkCandidates: () => notAvailable('Linking session files'),
    link: (_tool: string, _path?: string, _label?: string) => notAvailable('Linking session files'),

    // The demo's scan: the recorded result of `mecha serve --demo` (a made-up home).
    scanState: async () => ({
      running: state.scan.running,
      protected_option: state.data.scan.protected_option,
      report: state.scan.report ? clone(state.scan.report) : null,
    }),

    scanStart: async (_includeProtected = false) => {
      if (state.scan.running) {
        throw new ApiError(409, 'scan_running', 'A scan is already running.')
      }
      const recorded = state.data.scan.report
      if (!recorded) return notAvailable('Scanning')
      state.scan = { running: true, stop: false, report: null }
      emit('scan_started', {})
      setTimeout(async () => {
        for (let step = 1; step <= SCAN_STEPS; step++) {
          await new Promise((r) => setTimeout(r, SCAN_STEP_MS))
          if (state.scan.stop) {
            state.scan.running = false
            emit('scan_done', { cancelled: true, failed: false })
            return
          }
          emit('scan_progress', { files: Math.floor((recorded.files_scanned * step) / SCAN_STEPS) })
        }
        const at = now()
        const report = clone(recorded)
        report.finished_at = new Date(at).toISOString()
        report.expires_at = new Date(at + SCAN_TTL_MS).toISOString()
        for (const f of report.findings) {
          const imported = state.data.scan_imports[f.id]
          const id = imported?.added.credential.id
          if (id && state.items.has(id)) {
            f.stored_id = id
            f.importable = false
            f.not_importable = 'duplicate'
          }
          if (f.stored_id && !state.items.has(f.stored_id)) f.stored_id = null // deleted here
        }
        state.scan = { running: false, stop: false, report }
        emit('scan_done', {
          cancelled: false,
          failed: false,
          files: report.files_scanned,
          findings: report.findings.length,
        })
      }, 0)
      return { started: true }
    },

    scanStop: async () => {
      const stopping = state.scan.running
      if (stopping) state.scan.stop = true
      return { stopping }
    },

    scanImport: async (ids: string[]) => {
      const report = state.scan.report
      if (!report || (report.expires_at && Date.parse(report.expires_at) <= now())) {
        state.scan.report = null
        throw new ApiError(404, 'not_found', 'No scan to import from.')
      }
      const results = ids.map((fid) => {
        const finding = report.findings.find((f) => f.id === fid)
        const imported = state.data.scan_imports[fid]
        if (!finding) return { id: fid, ok: false, code: 'not_found' }
        if (!finding.importable || !imported) {
          return { id: fid, ok: false, code: finding.not_importable ?? 'not_found' }
        }
        const item = clone(imported.added)
        const id = item.credential.id
        state.items.set(id, item)
        state.importedOf.set(id, imported)
        state.history.set(id, [])
        finding.stored_id = id
        finding.importable = false
        finding.not_importable = 'duplicate'
        return clone(imported.result)
      })
      if (results.some((r) => r.ok)) emit('credentials_changed', {})
      return { results }
    },

    exposures: async (id: string) => {
      get(id)
      const home = state.data.scan.report?.home ?? ''
      return clone(
        state.data.exposures[id] ??
          state.importedOf.get(id)?.exposures ?? { home, scanned_at: null, exposures: [] },
      )
    },

    // The made-up files never change: scanning them again finds the same.
    rescanExposures: async (id: string) => {
      get(id)
      await new Promise((r) => setTimeout(r, 300))
      const home = state.data.scan.report?.home ?? ''
      return clone(
        state.data.exposures[id] ??
          state.importedOf.get(id)?.exposures ?? { home, scanned_at: null, exposures: [] },
      )
    },
  }
}

export type { Api }
