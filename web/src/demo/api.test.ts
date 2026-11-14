import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/errors'
import { makeApi, NOT_AVAILABLE } from './api'
import { subscribe } from './bus'
import { RAW } from './data'

const T0 = Date.parse('2027-01-10T10:00:00Z')

function clock(start = T0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const firstApiKey = () => {
  const item = RAW.listing.credentials.find(
    (c) => c.credential.kind === 'api_key' && RAW.probe[c.credential.id]?.status === 200,
  )
  if (!item) throw new Error('no probe-able demo credential')
  return item.credential.id
}

describe('web demo in-memory API', () => {
  it('lists the dumped credentials with dates moved to now', async () => {
    const c = clock()
    const api = makeApi(null, c.now)
    const listing = await api.list()
    expect(listing.credentials).toHaveLength(RAW.listing.credentials.length)
    expect(Date.parse(listing.generated_at)).toBe(T0)
    expect((await api.health()).demo).toBe(true)
  })

  it('applies the hourly probe limit; force (after confirmation) probes anyway', async () => {
    const c = clock()
    const api = makeApi(null, c.now)
    const id = firstApiKey()
    await api.probe(id, true)
    await expect(api.probe(id)).rejects.toMatchObject({ status: 409, code: 'probe_too_soon' })
    await expect(api.probe(id, true)).resolves.toBeTruthy()
    c.advance(61 * 60 * 1000)
    await expect(api.probe(id)).resolves.toBeTruthy()
  })

  it('adds only sample keys, once each; never a pasted secret', async () => {
    const api = makeApi(null, clock().now)
    const sample = RAW.samples[0]
    if (!sample) throw new Error('no samples')
    const added = await api.add({ secret: `sample:${sample.id}`, label: sample.label })
    expect(added.credential.redacted).toBe(sample.redacted)
    await expect(api.add({ secret: `sample:${sample.id}` })).rejects.toMatchObject({
      code: 'duplicate',
    })
    await expect(api.add({ secret: 'sk-ant-api03-pasted' })).rejects.toMatchObject({
      code: NOT_AVAILABLE,
    })
    const checked = await api.check(added.credential.id)
    expect(checked.credential.label).toBe(sample.label)
    expect((await api.history(added.credential.id)).history).toHaveLength(1)
  })

  it('refuses what would need the state engine or a pasted value', async () => {
    const api = makeApi(null, clock().now)
    const id = firstApiKey()
    const refused = [
      api.patch(id, {
        manual_budget: { amount: '10', currency: 'USD', purchased_at: '2027-01-01' },
      }),
      api.detect('anything'),
      api.envPreview('A=B'),
      api.envImport('A=B', [0]),
      api.linkCandidates(),
      api.link('codex'),
    ]
    for (const p of refused) {
      const err = await p.catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe(NOT_AVAILABLE)
    }
  })

  it('keeps label, tags and notes edits across checks', async () => {
    const api = makeApi(null, clock().now)
    const id = firstApiKey()
    await api.patch(id, { label: 'Renamed', tags: ['x'], notes: 'n' })
    const checked = await api.check(id)
    expect(checked.credential).toMatchObject({ label: 'Renamed', tags: ['x'], notes: 'n' })
  })

  it('check all reports progress over the in-page event stream, like the server', async () => {
    const api = makeApi(null, clock().now)
    const events: string[] = []
    const done = new Promise<void>((resolve) => {
      const off = subscribe((type) => {
        events.push(type)
        if (type === 'check_all_done') {
          off()
          resolve()
        }
      })
    })
    const started = await api.checkAll()
    expect(started.total).toBe(RAW.listing.credentials.length)
    await done
    expect(events[0]).toBe('check_all_started')
    expect(events.filter((e) => e === 'check_progress')).toHaveLength(started.total)
    expect(events.at(-1)).toBe('check_all_done')
  }, 10_000)

  it('removes in memory only', async () => {
    const api = makeApi(null, clock().now)
    const id = firstApiKey()
    await api.remove(id)
    expect((await api.list()).credentials.some((c) => c.credential.id === id)).toBe(false)
    expect((await makeApi(null, clock().now).list()).credentials).toHaveLength(
      RAW.listing.credentials.length,
    )
  })

  const scanned = (api: ReturnType<typeof makeApi>) =>
    new Promise<string[]>((resolve) => {
      const events: string[] = []
      const off = subscribe((type) => {
        events.push(type)
        if (type === 'scan_done') {
          off()
          resolve(events)
        }
      })
      void api.scanStart()
    })

  it('scans a made-up home, imports a finding and shows where a stored key was', async () => {
    const api = makeApi(null, clock().now)
    expect((await api.scanState()).report).toBeNull()
    const events = await scanned(api)
    expect(events[0]).toBe('scan_started')
    expect(events.filter((e) => e === 'scan_progress').length).toBeGreaterThan(1)
    const report = (await api.scanState()).report
    if (!report) throw new Error('no report')
    expect(report.home).toBe('/home/demo')
    expect(report.findings.every((f) => f.path.startsWith('/home/demo/'))).toBe(true)
    const finding = report.findings.find((f) => f.importable)
    if (!finding) throw new Error('nothing importable')
    const { results } = await api.scanImport([finding.id, finding.id])
    expect(results[0]?.ok).toBe(true)
    expect(results[1]).toMatchObject({ ok: false, code: 'duplicate' })
    const id = results[0]?.credential_id as string
    expect((await api.list()).credentials.some((c) => c.credential.id === id)).toBe(true)
    await expect(api.check(id)).resolves.toBeTruthy()
    expect((await api.exposures(id)).exposures.map((e) => e.path)).toEqual([finding.path])

    const stored = report.findings.find((f) => f.stored_id)?.stored_id as string
    const where = await api.exposures(stored)
    expect(where.exposures.length).toBeGreaterThan(0)
    expect((await api.rescanExposures(stored)).exposures).toEqual(where.exposures)
  }, 10_000)

  it('stops a scan and forgets the result after 30 minutes', async () => {
    const c = clock()
    const api = makeApi(null, c.now)
    const done = scanned(api)
    expect((await api.scanStop()).stopping).toBe(true)
    await done
    expect((await api.scanState()).report).toBeNull()
    await scanned(api)
    const report = (await api.scanState()).report
    const finding = report?.findings.find((f) => f.importable)
    c.advance(31 * 60 * 1000)
    await expect(api.scanImport([finding?.id as string])).rejects.toMatchObject({ status: 404 })
  }, 10_000)
})
