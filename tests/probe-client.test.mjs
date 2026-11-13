/**
 * client 读取逐源结局：新响应展示、旧响应兼容。
 *
 * 只加载真实 client 模块（attempts / currency），不重写解析逻辑。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

async function load(path, globals = {}) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
  })
  const ctx = { module: { exports: {} }, require: createRequire(import.meta.url), ...globals }
  ctx.exports = ctx.module.exports
  ctx.globalThis = ctx
  runInNewContext(result.outputFiles[0].text, ctx)
  return ctx.module.exports
}

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const response = (body) => ({ ok: true, json: async () => body })

test('old responses without per-source attempts stay displayable (null view, no throw)', async () => {
  const { toAttemptsView } = await load('src/client/attempts.tsx')
  for (const legacy of [undefined, null, [], 'nope', {}, [{ url: 'x' }], [{ outcome: 'success' }]]) {
    assert.equal(toAttemptsView(legacy), null, JSON.stringify(legacy))
  }
  // 只保留结构合法的条目；顺序按宿主 index 还原为实际尝试顺序。
  const view = toAttemptsView([
    { index: 1, url: 'https://b.example/x', outcome: 'timeout', durationMs: 8000, message: '超时' },
    { index: 0, url: 'https://a.example/x', outcome: 'http-error', status: 500, durationMs: 12 },
    { url: 'bad' },
  ])
  // vm 内的数组原型与宿主不同：展开后再比较。
  assert.deepEqual([...view.rows].map((r) => r.url), ['https://a.example/x', 'https://b.example/x'])
  assert.deepEqual([...view.rows].map((r) => r.outcome), ['http-error', 'timeout'])
  assert.equal(view.rows[0].status, 500)
  assert.equal(view.hit, undefined)
})

test('new rate response publishes attempt details into the shared display store', async () => {
  const { api } = { api: await load('src/client/currency.ts', {
    fetch: async () => response({
      ok: true,
      rate: 6.9,
      fetchedAt: 100,
      source: 'https://b.example/latest',
      sourceIndex: 1,
      attempts: [
        { index: 0, url: 'https://a.example/latest', outcome: 'http-error', status: 500, durationMs: 5 },
        { index: 1, url: 'https://b.example/latest', outcome: 'success', durationMs: 7 },
      ],
    }),
  }) }
  assert.equal(await api.refreshLiveRate(), 'ok')
  const meta = api.getDisplayMeta()
  assert.equal(meta.cnyPerUsd, 6.9)
  assert.equal(meta.rateAttemptSource, 'https://b.example/latest')
  assert.deepEqual(meta.rateAttempts.map((a) => a.outcome), ['http-error', 'success'])
})

test('old rate response without attempts still succeeds and leaves the view empty', async () => {
  const { api } = { api: await load('src/client/currency.ts', {
    fetch: async () => response({ ok: true, rate: 7.2, fetchedAt: 5 }),
  }) }
  assert.equal(await api.refreshLiveRate(), 'ok')
  const meta = api.getDisplayMeta()
  assert.equal(meta.cnyPerUsd, 7.2)
  assert.equal(meta.rateAttempts, undefined)
})

test('all-failed rate response surfaces each source and the readable summary', async () => {
  const { api } = { api: await load('src/client/currency.ts', {
    fetch: async () => response({
      ok: false,
      reason: 'request-failed',
      message: '全部 2 个汇率源均失败：…',
      attempts: [
        { index: 0, url: 'https://a.example/latest', outcome: 'timeout', durationMs: 8000 },
        { index: 1, url: 'https://b.example/latest', outcome: 'network-error', durationMs: 3, message: 'ENOTFOUND' },
      ],
    }),
  }) }
  assert.equal(await api.refreshLiveRate(), 'request-failed')
  const meta = api.getDisplayMeta()
  assert.deepEqual(meta.rateAttempts.map((a) => a.outcome), ['timeout', 'network-error'])
  assert.match(meta.rateMessage, /全部 2 个汇率源均失败/)
})

test('malformed attempt entries are dropped without breaking a valid success', async () => {
  const { api } = { api: await load('src/client/currency.ts', {
    fetch: async () => response({ ok: true, rate: 7, fetchedAt: 1, attempts: [{ nope: true }, 'x', { url: 'u', outcome: 'bogus' }] }),
  }) }
  assert.equal(await api.refreshLiveRate(), 'ok')
  assert.deepEqual(api.getDisplayMeta().rateAttempts, [])
})
