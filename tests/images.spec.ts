import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  cardImageOf,
  DEFAULT_IMAGE_LIMITS,
  imageReport,
  isPublicAddress,
  resolveCardImages,
  sniffImageType,
  urlFetcher,
  workspaceImageReader,
  type ImageLimits,
  type ImageOutcome,
  type ResolveOptions,
  type UrlFetcher,
} from '../src/images.ts'
import { inside, realpathOfDeepest, type ImageStore } from '../src/storage.ts'

/** Smallest valid-looking image of each kind, by signature. */
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])
const text = (s: string) => new TextEncoder().encode(s)

describe('sniffImageType', () => {
  it('identifies each accepted format by its bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(text('GIF89a\u0001\u0000'))).toBe('image/gif')
    expect(sniffImageType(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageType(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
    expect(sniffImageType(text('﻿<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg>'))).toBe('image/svg+xml')
  })

  it('refuses everything else, whatever it is called', () => {
    expect(sniffImageType(text('<!doctype html><title>404</title>'))).toBeUndefined()
    expect(sniffImageType(text('<html><body><svg></svg></body></html>'))).toBeUndefined()
    expect(sniffImageType(text('%PDF-1.7'))).toBeUndefined()
    expect(sniffImageType(new Uint8Array())).toBeUndefined()
  })
})

describe('isPublicAddress', () => {
  it.each([
    ['127.0.0.1', 4], ['10.1.2.3', 4], ['172.20.0.1', 4], ['192.168.1.1', 4], ['169.254.169.254', 4],
    ['100.64.0.1', 4], ['0.0.0.0', 4], ['224.0.0.1', 4], ['255.255.255.255', 4],
    ['::1', 6], ['::', 6], ['fe80::1', 6], ['fd00::1', 6], ['ff02::1', 6],
    ['::ffff:127.0.0.1', 6], ['::ffff:7f00:1', 6], ['::ffff:a9fe:a9fe', 6], ['64:ff9b::a00:1', 6],
  ] as const)('refuses %s', (address, family) => {
    expect(isPublicAddress(address, family)).toBe(false)
  })

  it.each([
    ['93.184.215.14', 4], ['1.1.1.1', 4], ['2606:4700:4700::1111', 6], ['::ffff:5db8:d70e', 6], ['64:ff9b::101:101', 6],
  ] as const)('admits %s', (address, family) => {
    expect(isPublicAddress(address, family)).toBe(true)
  })
})

/**
 * A `ctx.fs` over the real disk with the local backend's semantics: resolve
 * follows symlinks into a canonical key, contains compares canonical keys.
 */
function diskFs() {
  return {
    async resolve(path: string, opts: { cwd?: string } = {}) {
      const absolute = resolve(opts.cwd ?? '/', path)
      return { targetKey: await realpathOfDeepest(absolute), displayPath: absolute }
    },
    contains: (parent: { targetKey: string }, child: { targetKey: string }) =>
      parent.targetKey === child.targetKey || inside(parent.targetKey, child.targetKey),
    async stat(target: { targetKey: string }) {
      const info = await stat(target.targetKey).catch(() => undefined)
      if (info === undefined) return undefined
      return { version: 'v', type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
    },
    async readBytes(target: { targetKey: string }, _signal: unknown, maxBytes: number) {
      const data = await readFile(target.targetKey)
      if (data.byteLength > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
      return new Uint8Array(data)
    },
  }
}

/** An in-memory image store. */
function memoryStore(): ImageStore & { puts: number } {
  const ids = new Set<string>()
  const store = {
    puts: 0,
    async put(data: Uint8Array, type: string) {
      store.puts += 1
      const id = `s/${data.byteLength.toString(16).padStart(64, '0')}.${type === 'image/png' ? 'png' : 'jpg'}`
      ids.add(id)
      return id
    },
    exists: async (id: string) => ids.has(id),
  }
  return store
}

const signal = new AbortController().signal
const noFetch: UrlFetcher = async () => {
  throw new Error('no network in this test')
}

/** The single outcome of a one-image resolution. */
const oneOutcome = async (run: Promise<{ outcomes: ImageOutcome[] }>) => (await run).outcomes[0]!

describe('workspace images', () => {
  let base: string
  let workspace: string
  let outside: string

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'viz-img-')))
    workspace = join(base, 'ws')
    outside = join(base, 'outside')
    await mkdir(join(workspace, 'figs'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(workspace, 'figs', 'loss.png'), PNG)
    await writeFile(join(workspace, 'notes.png'), '# not an image')
    await writeFile(join(outside, 'secret.png'), PNG)
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const read = (fs: object = diskFs()) => workspaceImageReader({ fs } as unknown as Context, workspace)
  const run = async (fragment: string, options: Partial<ResolveOptions> = {}) => await resolveCardImages(fragment, {
    readFile: read(),
    fetchUrl: noFetch,
    store: memoryStore(),
    signal,
    ...options,
  })
  const reasons = async (src: string) => (await run(`<img data-viz-src="${src}" alt="x">`)).outcomes.map(o => o.reason)
  /** The failure outcomes of a run. */
  const failed = async (fragment: string, options: Partial<ResolveOptions> = {}) =>
    (await run(fragment, options)).outcomes.filter(o => !o.ok)

  it('reads a workspace file relative to the root', async () => {
    const { images, outcomes } = await run('<img data-viz-src="./figs/loss.png" alt="loss"><img data-viz-src="figs/loss.png">')
    expect(outcomes.filter(o => !o.ok)).toEqual([])
    expect(outcomes.map(o => [o.src, o.ok, o.origin, o.redirects])).toEqual([
      ['./figs/loss.png', true, 'file', 0],
      ['figs/loss.png', true, 'file', 0],
    ])
    expect(images.map(i => [i.src, i.type, i.bytes, i.origin])).toEqual([
      ['./figs/loss.png', 'image/png', PNG.byteLength, 'file'],
      ['figs/loss.png', 'image/png', PNG.byteLength, 'file'],
    ])
  })

  it('refuses paths that leave the workspace, lexically or through a symlink', async () => {
    await symlink(join(outside, 'secret.png'), join(workspace, 'figs', 'link.png'))
    await symlink(outside, join(workspace, 'escape'))
    for (const src of ['../outside/secret.png', join(outside, 'secret.png'), 'figs/../../outside/secret.png']) {
      expect(await reasons(src)).toEqual([expect.stringMatching(/^outside the workspace/u)])
    }
    expect(await reasons('figs/link.png')).toEqual([expect.stringMatching(/through a symlink/u)])
    expect(await reasons('escape/secret.png')).toEqual([expect.stringMatching(/through a symlink/u)])
    expect(await reasons('~/secret.png')).toEqual([expect.stringMatching(/~ is not expanded/u)])
    for (const src of ['../outside/secret.png', 'figs/link.png', '~/secret.png']) {
      const outcome = await oneOutcome(run(`<img data-viz-src="${src}">`))
      expect(outcome).toMatchObject({ ok: false, origin: 'file', category: 'workspace-refused', redirects: 0 })
    }
  })

  it('names what is wrong with a file inside it', async () => {
    expect(await reasons('figs/missing.png')).toEqual([expect.stringMatching(/^not found in the workspace/u)])
    expect(await reasons('figs')).toEqual(['not a regular file'])
    expect(await reasons('notes.png')).toEqual([expect.stringMatching(/^not a PNG, JPEG, GIF, WebP or SVG image \(the content starts "# not an image"\)/u)])
    expect(await oneOutcome(run('<img data-viz-src="figs/missing.png">')))
      .toMatchObject({ ok: false, category: 'file-unavailable', origin: 'file', redirects: 0 })
    expect(await oneOutcome(run('<img data-viz-src="notes.png">')))
      .toMatchObject({ ok: false, category: 'not-an-image', origin: 'file', redirects: 0 })
  })

  it('caps one image and the whole card', async () => {
    await writeFile(join(workspace, 'big.png'), new Uint8Array([...PNG, ...new Uint8Array(100)]))
    const small: ImageLimits = { ...DEFAULT_IMAGE_LIMITS, maxImageBytes: 64 }
    expect((await run('<img data-viz-src="big.png">', { limits: small })).outcomes[0]!)
      .toMatchObject({ ok: false, category: 'image-too-large', reason: expect.stringMatching(/limit for one image/u) })
    const card: ImageLimits = { ...DEFAULT_IMAGE_LIMITS, maxCardBytes: PNG.byteLength + JPEG.byteLength - 1 }
    await writeFile(join(workspace, 'second.png'), JPEG)
    const { images, outcomes } = await run('<img data-viz-src="figs/loss.png"><img data-viz-src="second.png">', { limits: card })
    expect(images.map(i => i.src)).toEqual(['figs/loss.png'])
    expect(outcomes.filter(o => !o.ok)).toEqual([
      expect.objectContaining({ src: 'second.png', category: 'card-too-large', reason: expect.stringMatching(/limit for one card/u) }),
    ])
    const few: ImageLimits = { ...DEFAULT_IMAGE_LIMITS, maxImages: 1 }
    const capped = await run('<img data-viz-src="figs/loss.png"><img data-viz-src="second.png">', { limits: few })
    expect(capped.outcomes.filter(o => !o.ok)).toEqual([
      expect.objectContaining({ src: 'second.png', category: 'too-many-images', reason: expect.stringMatching(/most one card takes/u) }),
    ])
  })

  it('keeps one outcome per source in document order, even past the image cap', async () => {
    const two: ImageLimits = { ...DEFAULT_IMAGE_LIMITS, maxImages: 2 }
    const fragment = '<img data-viz-src="figs/loss.png">'
      + '<img data-viz-src="figs/missing.png">'
      + '<img data-viz-src="figs/over-the-cap.png">'
    const { outcomes } = await run(fragment, { limits: two })
    expect(outcomes.map(o => o.src)).toEqual(['figs/loss.png', 'figs/missing.png', 'figs/over-the-cap.png'])
    expect(outcomes.map(o => o.ok)).toEqual([true, false, false])
    expect(outcomes[2]).toMatchObject({ category: 'too-many-images', origin: 'file', redirects: 0 })
  })

  it('charges an image once per reference, since every reference embeds a full copy', async () => {
    await writeFile(join(workspace, 'second.png'), JPEG)
    const limits: ImageLimits = { ...DEFAULT_IMAGE_LIMITS, maxCardBytes: PNG.byteLength * 3 + JPEG.byteLength }
    const repeated = (n: number) => '<img data-viz-src="figs/loss.png">'.repeat(n) + '<img data-viz-src="second.png">'
    const fits = await run(repeated(3), { limits })
    expect(fits.outcomes.filter(o => !o.ok)).toEqual([])
    expect(fits.images.map(i => i.src)).toEqual(['figs/loss.png', 'second.png'])
    // One more reference and the repeated image alone would overrun the card.
    const over = await run(repeated(4), { limits })
    expect(over.images.map(i => i.src)).toEqual(['second.png'])
    expect(over.outcomes.filter(o => !o.ok)).toEqual([
      expect.objectContaining({ src: 'figs/loss.png', category: 'card-too-large', reason: expect.stringMatching(/referenced 4 times/u) }),
    ])
  })

  it('degrades with a message on a host whose fs cannot read bytes', async () => {
    const { readBytes: _, ...old } = diskFs()
    const { outcomes } = await run('<img data-viz-src="figs/loss.png">', { readFile: read(old) })
    expect(outcomes[0]!).toMatchObject({ ok: false, category: 'file-unavailable', reason: expect.stringMatching(/cannot read binary workspace files/u) })
  })

  it('reports every image undeliverable, without reading anything, when the host cannot deliver them', async () => {
    let reads = 0
    const { images, outcomes } = await run('<img data-viz-src="figs/loss.png"><img data-viz-src="https://example.com/a.png">', {
      readFile: async () => {
        reads += 1
        return PNG
      },
      unavailable: 'no route here',
    })
    expect(images).toEqual([])
    expect(outcomes.map(o => [o.ok, o.category, o.reason, o.redirects])).toEqual([
      [false, 'unavailable', 'no route here', 0],
      [false, 'unavailable', 'no route here', 0],
    ])
    expect(reads).toBe(0)
  })
})

describe('URL images', () => {
  let server: Server
  let port: number
  const hits: string[] = []

  /** When the server saw each endless response's connection close. */
  const closed = new Map<string, Promise<void>>()
  /** A response whose body never ends: it writes as fast as the client reads. */
  const endless = (path: string, res: import('node:http').ServerResponse, status: number, headers: Record<string, string>) => {
    closed.set(path, new Promise(done => res.on('close', () => done())))
    res.writeHead(status, headers)
    const chunk = Buffer.alloc(64 * 1024)
    const pump = () => {
      while (!res.destroyed && res.write(chunk)) { /* keep the pipe full */ }
    }
    res.on('drain', pump)
    pump()
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url!)
      const path = req.url!
      if (path === '/a.png') return res.end(PNG)
      if (path === '/page') return res.end('<!doctype html><p>hi</p>')
      if (path === '/missing.png') return res.writeHead(404).end()
      if (path === '/big.png') return res.end(Buffer.concat([Buffer.from(PNG), Buffer.alloc(4096)]))
      if (path === '/chunked.png') {
        res.write(PNG)
        res.write(Buffer.alloc(4096))
        return res.end()
      }
      if (path === '/loop') return res.writeHead(302, { location: '/loop' }).end()
      if (path === '/to-a') return res.writeHead(301, { location: '/a.png' }).end()
      if (path === '/to-metadata') return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end()
      if (path === '/to-file') return res.writeHead(302, { location: 'file:///etc/passwd' }).end()
      if (path === '/hang') return
      if (path === '/endless-404') return endless(path, res, 404, {})
      if (path === '/endless-302') return endless(path, res, 302, { location: '/a.png' })
      res.writeHead(500).end()
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  })
  beforeEach(() => {
    hits.length = 0
  })

  /** A fetcher allowed to reach this test's server on 127.0.0.1 and nothing else. */
  const local = urlFetcher({ maxRedirects: 3, policy: address => address === '127.0.0.1' })
  const fetchOne = async (src: string, fetchUrl: UrlFetcher = local, limits: ImageLimits = DEFAULT_IMAGE_LIMITS) =>
    await resolveCardImages(`<img data-viz-src="${src}">`, { readFile: read, fetchUrl, store: memoryStore(), signal, limits })
  /** The single outcome of a one-image fetch. */
  const outcomeOf = async (src: string, fetchUrl: UrlFetcher = local, limits: ImageLimits = DEFAULT_IMAGE_LIMITS) =>
    (await fetchOne(src, fetchUrl, limits)).outcomes[0]!
  const read = async () => {
    throw new Error('no files in this test')
  }

  it('refuses loopback, private and metadata targets before connecting (default policy)', async () => {
    const guarded = urlFetcher({ maxRedirects: 3 })
    for (const src of [
      `http://127.0.0.1:${port}/a.png`,
      `http://localhost:${port}/a.png`,
      `http://[::1]:${port}/a.png`,
      `http://[::ffff:127.0.0.1]:${port}/a.png`,
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/a.png',
    ]) {
      const { images, outcomes } = await fetchOne(src, guarded)
      expect(images).toEqual([])
      expect(outcomes[0]!).toMatchObject({
        ok: false, category: 'blocked-address', origin: 'url', redirects: 0,
        reason: expect.stringMatching(/loopback, private or link-local address/u),
      })
    }
    expect(hits).toEqual([])
  })

  it('connects to a name only through the guarded lookup', async () => {
    const loopback = urlFetcher({ maxRedirects: 3, policy: address => address === '127.0.0.1' || address === '::1' })
    const { images, outcomes } = await fetchOne(`http://localhost:${port}/a.png`, loopback)
    expect(outcomes.filter(o => !o.ok)).toEqual([])
    expect(outcomes[0]).toMatchObject({ ok: true, origin: 'url', redirects: 0 })
    expect(images.map(i => i.bytes)).toEqual([PNG.byteLength])
  })

  it('fetches an image and follows a redirect, recording the real redirect count', async () => {
    const { images, outcomes } = await fetchOne(`http://127.0.0.1:${port}/to-a`)
    expect(images.map(i => [i.type, i.bytes, i.origin])).toEqual([['image/png', PNG.byteLength, 'url']])
    expect(outcomes[0]).toMatchObject({ src: `http://127.0.0.1:${port}/to-a`, ok: true, origin: 'url', redirects: 1 })
    expect(hits).toEqual(['/to-a', '/a.png'])
    const direct = await outcomeOf(`http://127.0.0.1:${port}/a.png`)
    expect(direct).toMatchObject({ ok: true, redirects: 0 })
  })

  it('checks every redirect hop against the policy and the scheme', async () => {
    const blocked = await outcomeOf(`http://127.0.0.1:${port}/to-metadata`)
    expect(blocked).toMatchObject({
      ok: false, category: 'blocked-address', redirects: 1,
      reason: expect.stringMatching(/169\.254\.169\.254 is a loopback, private/u),
    })
    const badScheme = await outcomeOf(`http://127.0.0.1:${port}/to-file`)
    expect(badScheme).toMatchObject({
      ok: false, category: 'unsupported-source', redirects: 1,
      reason: expect.stringMatching(/file: URL/u),
    })
    const loop = await outcomeOf(`http://127.0.0.1:${port}/loop`)
    expect(loop).toMatchObject({ ok: false, category: 'too-many-redirects', redirects: 4 })
    expect(loop.reason).toBe('more than 3 redirects')
    expect(hits.filter(hit => hit === '/loop')).toHaveLength(4)
  })

  it('files redirect-limit and timeout failures under their own categories', async () => {
    const limited = urlFetcher({ maxRedirects: 1, policy: address => address === '127.0.0.1' })
    const over = await outcomeOf(`http://127.0.0.1:${port}/loop`, limited)
    expect(over).toMatchObject({ ok: false, category: 'too-many-redirects', redirects: 2 })
    expect(over.reason).toBe('more than 1 redirects')

    const small = { ...DEFAULT_IMAGE_LIMITS, timeoutMs: 200 }
    const timedOut = await outcomeOf(`http://127.0.0.1:${port}/hang`, local, small)
    expect(timedOut).toMatchObject({ ok: false, category: 'timeout', redirects: 0 })
    expect(timedOut.reason).toBe('timed out')
  })

  it('refuses what is not an image, missing, too large, or too slow', async () => {
    expect(await outcomeOf(`http://127.0.0.1:${port}/page`))
      .toMatchObject({ ok: false, category: 'not-an-image', reason: expect.stringMatching(/^not a PNG/u) })
    expect(await outcomeOf(`http://127.0.0.1:${port}/missing.png`))
      .toMatchObject({ ok: false, category: 'http-status', reason: 'the server answered HTTP 404' })
    const small = { ...DEFAULT_IMAGE_LIMITS, maxImageBytes: 1024, timeoutMs: 200 }
    expect(await outcomeOf(`http://127.0.0.1:${port}/big.png`, local, small))
      .toMatchObject({ ok: false, category: 'image-too-large', reason: expect.stringMatching(/limit for one image/u) })
    expect(await outcomeOf(`http://127.0.0.1:${port}/chunked.png`, local, small))
      .toMatchObject({ ok: false, category: 'image-too-large', reason: expect.stringMatching(/limit for one image/u) })
    expect(await outcomeOf(`http://127.0.0.1:${port}/hang`, local, small))
      .toMatchObject({ ok: false, category: 'timeout', reason: 'timed out' })
    expect(await outcomeOf(`http://user:pw@127.0.0.1:${port}/a.png`))
      .toMatchObject({ ok: false, category: 'unsupported-source', reason: expect.stringMatching(/credentials/u) })
    expect(await outcomeOf('ftp://example.com/a.png'))
      .toMatchObject({ ok: false, category: 'unsupported-source', reason: expect.stringMatching(/ftp: URLs are not supported/u) })
    expect(await outcomeOf('data:image/png;base64,AAAA'))
      .toMatchObject({ ok: false, category: 'unsupported-source', reason: expect.stringMatching(/put it in src/u) })
  })

  it('drops an unread redirect or error body at once instead of draining it to the deadline', async () => {
    const within = async (path: string) => await Promise.race([
      closed.get(path)!.then(() => 'closed'),
      new Promise(done => setTimeout(() => done('still streaming'), 1500)),
    ])
    expect((await fetchOne(`http://127.0.0.1:${port}/endless-404`)).outcomes[0])
      .toMatchObject({ ok: false, category: 'http-status', reason: 'the server answered HTTP 404' })
    expect(await within('/endless-404')).toBe('closed')
    expect((await fetchOne(`http://127.0.0.1:${port}/endless-302`)).images).toHaveLength(1)
    expect(await within('/endless-302')).toBe('closed')
  })

  it('carries a URL image an earlier call fetched instead of fetching it again', async () => {
    const store = memoryStore()
    const src = `http://127.0.0.1:${port}/a.png`
    const first = await resolveCardImages(`<img data-viz-src="${src}">`, { readFile: read, fetchUrl: local, store, signal })
    const second = await resolveCardImages(`<p>patched</p><img data-viz-src="${src}">`, {
      readFile: read, fetchUrl: local, store, signal, previous: first.images,
    })
    expect(second.images).toEqual(first.images)
    expect(hits).toEqual(['/a.png'])
  })

  it('lists a success and a failure as separate lines in imageReport, each with its ending', async () => {
    const goodSrc = `http://127.0.0.1:${port}/to-a`
    const badSrc = `http://127.0.0.1:${port}/missing.png`
    const store = memoryStore()
    const resolved = await resolveCardImages(
      `<img data-viz-src="${goodSrc}"><img data-viz-src="${badSrc}">`,
      { readFile: read, fetchUrl: local, store, signal },
    )
    expect(resolved.images).toHaveLength(1)
    expect(resolved.outcomes).toEqual([
      expect.objectContaining({ src: goodSrc, ok: true, origin: 'url', redirects: 1 }),
      expect.objectContaining({ src: badSrc, ok: false, origin: 'url', redirects: 0, category: 'http-status' }),
    ])
    const report = imageReport(resolved.images.map(cardImageOf), resolved.outcomes)!
    const lines = report.split('\n')
    // The summary, one success line, the failure head, and one failure line.
    expect(lines[0]).toBe(`Embedded 1 image (1 KB, stored beside the card).`)
    expect(lines).toContain(`- ${JSON.stringify(goodSrc)}: embedded (followed 1 redirect)`)
    expect(lines).toContain('1 image could not be embedded and shows a placeholder; fix each data-viz-src and patch the card:')
    expect(lines).toContain(`- ${JSON.stringify(badSrc)}: [http-status] the server answered HTTP 404`)
  })

  it('keeps imageReport to one summary line when every image succeeds', async () => {
    const resolved = await fetchOne(`http://127.0.0.1:${port}/a.png`)
    const report = imageReport(resolved.images.map(cardImageOf), resolved.outcomes)!
    expect(report).toBe('Embedded 1 image (1 KB, stored beside the card).')
    expect(report).not.toContain('placeholder')
    expect(imageReport([], [])).toBeUndefined()
  })
})
