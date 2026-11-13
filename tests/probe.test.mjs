/**
 * 宿主采集的逐源结局：余额与实时汇率。
 *
 * 全部使用本地伪造 fetch（不触网）：
 *  - 成功、HTTP 500、超时、响应结构非法；
 *  - 主源失败后回退源成功（命中源标注）与全部失败（保留每源结局）；
 *  - 顺序、结局类型、整体 ok、耗时；
 *  - 响应绝不含 API Key，敏感查询参数被脱敏。
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import {
  apply,
  probeBalance,
  probeRate,
  redactSourceUrl,
  scrubSecrets,
} from '../lib/index.js'

const disposers = []
after(() => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() })

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const emptyResponse = (status) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({}),
})

/** 永不自行 resolve，仅在 AbortSignal 触发时以 AbortError 拒绝。 */
const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => {
    const error = new Error('The operation was aborted')
    error.name = 'AbortError'
    reject(error)
  })
})

/** 按调用顺序返回不同实现的 fetch，并记录调用过的 URL。 */
function sequencedFetch(steps) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method })
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    return step(url, init, calls.length - 1)
  }
  impl.calls = calls
  return impl
}

const BALANCE_BASE = 'http://127.0.0.1:9'
const SECRET = 'sk-test-secret-0123456789'

function assertAttemptShape(attempt, index) {
  assert.equal(attempt.index, index)
  assert.equal(typeof attempt.url, 'string')
  assert.equal(typeof attempt.outcome, 'string')
  assert.equal(typeof attempt.durationMs, 'number')
  assert.ok(attempt.durationMs >= 0)
}

// ── 余额 ────────────────────────────────────────────────────────────────────

test('balance success records one successful source with a non-negative duration', async () => {
  const fetchImpl = sequencedFetch([() => jsonResponse({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '10.5', granted_balance: '1', topped_up_balance: '9.5' }],
  })])
  const result = await probeBalance(SECRET, BALANCE_BASE, { fetchImpl, timeoutMs: 200 })
  assert.equal(result.ok, true)
  assert.equal(result.apiKeyConfigured, true)
  assert.equal(result.source, 'api')
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['success'])
  assertAttemptShape(result.attempts[0], 0)
  assert.equal(result.attempts[0].url, `${BALANCE_BASE}/user/balance`)
  assert.equal(fetchImpl.calls[0].method, 'GET')
})

test('balance HTTP 500 is a structured http-error that keeps the status code', async () => {
  const result = await probeBalance(SECRET, BALANCE_BASE, {
    fetchImpl: async () => emptyResponse(500),
    timeoutMs: 200,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'request-failed')
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0].outcome, 'http-error')
  assert.equal(result.attempts[0].status, 500)
  assert.match(result.message, /HTTP 500/)
})

test('balance timeout is reported as timeout, not a thrown exception', async () => {
  const result = await probeBalance(SECRET, BALANCE_BASE, { fetchImpl: hangingFetch, timeoutMs: 20 })
  assert.equal(result.ok, false)
  assert.equal(result.attempts[0].outcome, 'timeout')
  assert.match(result.attempts[0].message, /超时/)
  assert.match(result.message, /超时/)
})

test('balance network failure is a structured network-error', async () => {
  const result = await probeBalance(SECRET, BALANCE_BASE, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
    timeoutMs: 200,
  })
  assert.equal(result.ok, false)
  assert.equal(result.attempts[0].outcome, 'network-error')
  assert.equal(result.reason, 'request-failed')
})

test('balance distinguishes a missing balance_infos field from an empty one', async () => {
  for (const body of [{ is_available: true }, { is_available: true, balance_infos: [] }]) {
    const result = await probeBalance(SECRET, BALANCE_BASE, { fetchImpl: async () => jsonResponse(body), timeoutMs: 200 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'bad-response')
    assert.equal(result.attempts[0].outcome, 'bad-response')
    assert.match(result.message, /balance_infos/)
  }
})

test('balance reports non-JSON responses as bad-response', async () => {
  const result = await probeBalance(SECRET, BALANCE_BASE, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token') } }),
    timeoutMs: 200,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'bad-response')
  assert.equal(result.attempts[0].outcome, 'bad-response')
})

test('balance never leaks the API key, even when the upstream echoes it in an error', async () => {
  const result = await probeBalance(SECRET, BALANCE_BASE, {
    fetchImpl: async () => { throw new Error(`socket closed while sending Bearer ${SECRET}`) },
    timeoutMs: 200,
  })
  const text = JSON.stringify(result)
  assert.ok(!text.includes(SECRET), text)
  assert.match(result.message, /\*\*\*/)
})

// ── 汇率 ────────────────────────────────────────────────────────────────────

test('rate success stops at the first valid source and marks it as the hit source', async () => {
  const urls = ['https://a.example/latest', 'https://b.example/latest']
  const fetchImpl = sequencedFetch([() => jsonResponse({ rates: { CNY: 6.77 } })])
  const result = await probeRate(urls, { fetchImpl, timeoutMs: 200 })
  assert.equal(result.ok, true)
  assert.equal(result.rate, 6.77)
  assert.equal(result.source, urls[0])
  assert.equal(result.sourceIndex, 0)
  assert.equal(fetchImpl.calls.length, 1, '命中后不应继续请求后面的源')
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['success'])
})

test('rate falls back on HTTP errors in attempt order and reports the hit source index', async () => {
  const urls = ['https://primary.example/latest', 'https://fallback.example/latest']
  const fetchImpl = sequencedFetch([
    () => emptyResponse(500),
    () => jsonResponse({ rates: { CNY: 6.7 } }),
  ])
  const result = await probeRate(urls, { fetchImpl, timeoutMs: 200 })
  assert.equal(result.ok, true)
  assert.equal(result.rate, 6.7)
  assert.equal(result.source, urls[1])
  assert.equal(result.sourceIndex, 1)
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['http-error', 'success'])
  assert.deepEqual(result.attempts.map((a) => a.index), [0, 1])
  assert.equal(result.attempts[0].url, urls[0])
  assert.equal(result.attempts[0].status, 500)
  assert.equal(result.attempts[1].url, urls[1])
})

test('rate falls back after a timeout and after an invalid structure', async () => {
  const urls = ['https://a.example/latest', 'https://b.example/latest', 'https://c.example/latest']
  const fetchImpl = sequencedFetch([
    hangingFetch,
    () => jsonResponse({ rates: { CNY: -1 } }),
    () => jsonResponse({ rates: { CNY: 7.1 } }),
  ])
  const result = await probeRate(urls, { fetchImpl, timeoutMs: 20 })
  assert.equal(result.ok, true)
  assert.equal(result.rate, 7.1)
  assert.equal(result.source, urls[2])
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['timeout', 'bad-response', 'success'])
  assert.deepEqual(result.attempts.map((a) => a.index), [0, 1, 2])
})

test('rate keeps every attempt when all sources fail, in attempt order', async () => {
  const urls = ['https://a.example/latest', 'https://b.example/latest', 'https://c.example/latest']
  const fetchImpl = sequencedFetch([
    () => emptyResponse(503),
    () => jsonResponse({ nope: true }),
    () => { throw new Error('ENOTFOUND') },
  ])
  const result = await probeRate(urls, { fetchImpl, timeoutMs: 200 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'request-failed')
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['http-error', 'bad-response', 'network-error'])
  assert.deepEqual(result.attempts.map((a) => a.index), [0, 1, 2])
  assert.deepEqual(result.attempts.map((a) => a.url), urls)
  // 不能只保留最后一条：全部结局与摘要都要在。
  assert.match(result.message, /a\.example/)
  assert.match(result.message, /b\.example/)
  assert.match(result.message, /c\.example/)
  assert.ok(!('source' in result))
})

test('rate reports an empty source list instead of throwing', async () => {
  const result = await probeRate([], { fetchImpl: async () => jsonResponse({}), timeoutMs: 20 })
  assert.equal(result.ok, false)
  assert.deepEqual(result.attempts, [])
})

test('rate redacts sensitive query parameters and never emits the API key', async () => {
  const urls = ['https://fx.example/latest?base=USD&api_key=' + SECRET]
  const result = await probeRate(urls, {
    fetchImpl: async () => jsonResponse({ rates: { CNY: 6.8 } }),
    timeoutMs: 200,
  })
  const text = JSON.stringify(result)
  assert.ok(!text.includes(SECRET), text)
  assert.match(result.attempts[0].url, /api_key=\*\*\*/)
  assert.match(result.attempts[0].url, /base=USD/)
})

test('rate failure messages echoing the full source URL are redacted too', async () => {
  const url = `https://fx.example/latest?api_key=${SECRET}`
  const result = await probeRate([url], {
    fetchImpl: async () => { throw new Error(`request to ${url} failed: ENOTFOUND`) },
    timeoutMs: 200,
  })
  assert.equal(result.ok, false)
  const text = JSON.stringify(result)
  assert.ok(!text.includes(SECRET), text)
  assert.match(result.attempts[0].message, /api_key=\*\*\*/)
  assert.match(result.message, /api_key=\*\*\*/)
})

test('redactSourceUrl strips credentials, fragments and sensitive query values', () => {
  const redacted = redactSourceUrl('https://user:pass@fx.example/v1/latest?base=USD&token=abc123&key=zzz#frag')
  assert.ok(!redacted.includes('user'))
  assert.ok(!redacted.includes('pass'))
  assert.ok(!redacted.includes('abc123'))
  assert.ok(!redacted.includes('zzz'))
  assert.ok(!redacted.includes('#frag'))
  assert.match(redacted, /token=\*\*\*/)
  assert.match(redacted, /key=\*\*\*/)
  assert.match(redacted, /base=USD/)
})

test('scrubSecrets removes every occurrence of a key-length secret', () => {
  assert.equal(scrubSecrets('a sk-secret-xyz b sk-secret-xyz', ['sk-secret-xyz']), 'a *** b ***')
  // 过短的字符串不作为密钥替换，避免误伤普通文本。
  assert.equal(scrubSecrets('prefix ab suffix', ['ab']), 'prefix ab suffix')
})

// ── 路由层 ──────────────────────────────────────────────────────────────────

function responseRecorder() {
  return {
    headers: {},
    status: 0,
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) },
    end(body) { this.body = body ?? '' },
  }
}

function routesWith(config) {
  const routes = new Map()
  apply({
    effect(setup) { disposers.push(setup()) },
    get() { return undefined },
    webServer: { register(route) { routes.set(route.path, route); return () => {} } },
    sessions: { get() { return undefined } },
  }, config)
  return routes
}

const sameOrigin = { host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }

async function callRoute(path, config) {
  const route = routesWith(config).get(path)
  const recorder = responseRecorder()
  await route.handler({ method: 'GET', url: path, headers: { ...sameOrigin } }, recorder)
  return { recorder, body: JSON.parse(recorder.body) }
}

test('balance route returns per-source attempts, no-store, and no key material', async () => {
  const { recorder, body } = await callRoute('/dsh-usage-chart/balance', {
    apiKey: SECRET,
    baseUrl: BALANCE_BASE,
    timeoutMs: 500,
    fetchImpl: async () => jsonResponse({ balance_infos: [{ currency: 'CNY', total_balance: '5' }] }),
  })
  assert.equal(recorder.status, 200)
  assert.equal(recorder.headers['Cache-Control'], 'no-store')
  assert.equal(body.ok, true)
  assert.deepEqual(body.attempts.map((a) => a.outcome), ['success'])
  assert.ok(!recorder.body.includes(SECRET))
})

test('balance route reports no-api-key with an empty attempt list', async () => {
  const previous = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  try {
    const { body } = await callRoute('/dsh-usage-chart/balance', {
      baseUrl: BALANCE_BASE,
      fetchImpl: async () => { throw new Error('must not be called') },
    })
    assert.equal(body.apiKeyConfigured, false)
    assert.equal(body.reason, 'no-api-key')
    assert.deepEqual(body.attempts, [])
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previous
  }
})

test('rate route exposes multi-source fallback with the hit source, and no secret', async () => {
  const calls = []
  const { recorder, body } = await callRoute('/dsh-usage-chart/rate', {
    fxUrl: `https://primary.example/latest?api_key=${SECRET}`,
    timeoutMs: 500,
    fetchImpl: async (url) => {
      calls.push(String(url))
      if (calls.length === 1) return emptyResponse(502)
      return jsonResponse({ rates: { CNY: 6.66 } })
    },
  })
  assert.equal(recorder.status, 200)
  assert.equal(recorder.headers['Cache-Control'], 'no-store')
  assert.equal(body.ok, true)
  assert.equal(body.rate, 6.66)
  assert.equal(body.sourceIndex, 1)
  assert.deepEqual(body.attempts.map((a) => a.outcome), ['http-error', 'success'])
  assert.ok(!recorder.body.includes(SECRET), recorder.body)
  // 配置源在前、内置回退源在后，顺序即实际尝试顺序。
  assert.match(body.attempts[0].url, /primary\.example/)
  assert.match(body.attempts[1].url, /frankfurter\.dev/)
  assert.equal(body.source, body.attempts[1].url)
})

test('rate route preserves every attempt when all sources fail', async () => {
  const { body } = await callRoute('/dsh-usage-chart/rate', {
    fxUrl: 'https://primary.example/latest',
    timeoutMs: 500,
    fetchImpl: async () => emptyResponse(500),
  })
  assert.equal(body.ok, false)
  assert.equal(body.attempts.length, 2)
  assert.deepEqual(body.attempts.map((a) => a.outcome), ['http-error', 'http-error'])
  assert.ok(body.message.includes('primary.example'))
  assert.ok(body.message.includes('frankfurter.dev'))
})

test('rate route rejects non-GET with 405 and cross-origin with 403', async () => {
  const route = routesWith({}).get('/dsh-usage-chart/rate')

  const methodResponse = responseRecorder()
  await route.handler({ method: 'POST', url: '/dsh-usage-chart/rate', headers: {} }, methodResponse)
  assert.equal(methodResponse.status, 405)
  assert.equal(methodResponse.headers.Allow, 'GET')

  const originResponse = responseRecorder()
  await route.handler({
    method: 'GET',
    url: '/dsh-usage-chart/rate',
    headers: { host: 'localhost:3000', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  }, originResponse)
  assert.equal(originResponse.status, 403)
  assert.equal(originResponse.headers['Cache-Control'], 'no-store')
})
