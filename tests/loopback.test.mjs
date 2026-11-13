/**
 * 回环 HTTP 服务上的真实 fetch 路径（不使用伪造 fetch）。
 *
 * 覆盖：成功、HTTP 500、真实超时、响应结构非法、主源失败→回退源成功、
 * 全部失败；并断言 `attempts` 与整体 `ok`、命中源标注。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test, { after, before } from 'node:test'

import { probeBalance, probeRate } from '../lib/index.js'

const routes = new Map()
let server
let origin = ''

before(async () => {
  server = createServer((req, res) => {
    const handler = routes.get(req.url)
    if (handler === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

const sendJson = (status, body) => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

test('loopback balance: success carries a single successful attempt', async () => {
  routes.set('/user/balance', sendJson(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '3.2' }] }))
  const result = await probeBalance('sk-loopback-test', origin, { timeoutMs: 2000 })
  assert.equal(result.ok, true)
  assert.equal(result.balances[0].currency, 'USD')
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['success'])
  assert.equal(result.attempts[0].url, `${origin}/user/balance`)
})

test('loopback balance: a real HTTP 500 becomes http-error with status', async () => {
  routes.set('/user/balance', sendJson(500, { error: 'boom' }))
  const result = await probeBalance('sk-loopback-test', origin, { timeoutMs: 2000 })
  assert.equal(result.ok, false)
  assert.equal(result.attempts[0].outcome, 'http-error')
  assert.equal(result.attempts[0].status, 500)
})

test('loopback balance: a real slow endpoint is aborted as timeout', async () => {
  routes.set('/user/balance', (_req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('{}') }, 500)
  })
  const result = await probeBalance('sk-loopback-test', origin, { timeoutMs: 40 })
  assert.equal(result.ok, false)
  assert.equal(result.attempts[0].outcome, 'timeout')
})

test('loopback balance: invalid JSON is bad-response', async () => {
  routes.set('/user/balance', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('not json')
  })
  const result = await probeBalance('sk-loopback-test', origin, { timeoutMs: 2000 })
  assert.equal(result.ok, false)
  assert.equal(result.attempts[0].outcome, 'bad-response')
})

test('loopback rate: primary 500 then fallback success in attempt order', async () => {
  routes.set('/fx-primary', sendJson(500, { error: 'down' }))
  routes.set('/fx-fallback', sendJson(200, { rates: { CNY: 6.55 } }))
  const result = await probeRate([`${origin}/fx-primary`, `${origin}/fx-fallback`], { timeoutMs: 2000 })
  assert.equal(result.ok, true)
  assert.equal(result.rate, 6.55)
  assert.equal(result.source, `${origin}/fx-fallback`)
  assert.equal(result.sourceIndex, 1)
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['http-error', 'success'])
})

test('loopback rate: all sources failing keeps every attempt', async () => {
  routes.set('/fx-500', sendJson(503, {}))
  routes.set('/fx-bad', sendJson(200, { rates: { CNY: 'six' } }))
  routes.set('/fx-slow', (_req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('{"rates":{"CNY":7}}') }, 500)
  })
  const result = await probeRate([`${origin}/fx-500`, `${origin}/fx-bad`, `${origin}/fx-slow`], { timeoutMs: 40 })
  assert.equal(result.ok, false)
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['http-error', 'bad-response', 'timeout'])
  assert.deepEqual(result.attempts.map((a) => a.index), [0, 1, 2])
  assert.ok(!JSON.stringify(result).includes('sk-loopback-test'))
})
