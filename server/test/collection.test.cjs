'use strict'

// Tests for the data collection summary: data.mjs records the outcome of
// every API request in data.json, and cron.sh reports the failed interfaces
// on stdout. A local fake HTTP server stands in for the Mempool and quote
// APIs, so these tests never touch the public network.

const assert = require('node:assert/strict')
const http = require('node:http')
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { join } = require('node:path')
const { spawn } = require('node:child_process')
const { test } = require('node:test')

const root = join(__dirname, '..')
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const png = (label) => Buffer.concat([PNG_HEADER, Buffer.from(label)])

const HEX = 875001

// Every Mempool endpoint data.mjs requests for DISPLAY_THEME=random, in call
// order; the quote API is requested under the name "quote".
const MEMPOOL_ENDPOINTS = [
  'blocks',
  'prices',
  'fees/precise',
  'fees/mempool-blocks',
  'mempool',
  'mining/pools/1w',
  'difficulty-adjustment',
  'lightning/statistics/latest',
  'lightning/nodes/countries',
]

const BODIES = {
  '/api/v1/blocks': [{ height: HEX, id: 'block-1' }, { height: HEX - 1 }],
  '/api/v1/prices': { USD: 100000, EUR: 90000 },
  '/api/v1/fees/precise': { fastestFee: 12 },
  '/api/v1/fees/recommended': { fastestFee: 10 },
  '/api/v1/fees/mempool-blocks': [
    { feeRange: [1, 2], medianFee: 1, nTx: 10 },
    { feeRange: [3, 4], medianFee: 3, nTx: 20 },
    { feeRange: [5, 6], medianFee: 5, nTx: 30 },
  ],
  '/api/v1/mempool': { count: 1000 },
  '/api/v1/mining/pools/1w': { pools: [{ name: 'pool', blockCount: 10 }] },
  '/api/v1/difficulty-adjustment': { progressPercent: 50 },
  '/api/v1/lightning/statistics/latest': { latest: { node_count: 100 } },
  '/api/v1/lightning/nodes/countries': [{ name: 'US', count: 10 }],
  '/quotes/random.json': { body: 'quote', author: { name: 'author' } },
}

// A local stand-in for the remote APIs.
//   fail: path -> HTTP status to answer with
//   hang: paths that accept the request but never answer (client timeout)
//   bodies: replaces the JSON body for a path
//   raw: path -> raw body string, sent verbatim (e.g. malformed JSON)
async function fakeApi({ fail = {}, hang = [], bodies = {}, raw = {} } = {}) {
  const responses = { ...BODIES, ...bodies }
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    res.on('error', () => {}) // the client may hang up early (oversized body)
    req.on('error', () => {})
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (hang.includes(path)) {
      sockets.add(req.socket)
      req.socket.on('close', () => sockets.delete(req.socket))
      return // keep the connection open: the client must time out
    }
    const status = fail[path]
    if (status) {
      res.writeHead(status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'boom' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(raw[path] ?? JSON.stringify(responses[path] ?? null))
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}

// A throwaway server directory: the real cron.sh, data.mjs and helpers.mjs
// with a fake firefox-esr/pngcrush on PATH, so the whole pipeline runs
// offline. It lives inside server/ so Node's ESM loader finds dotenv in
// server/node_modules.
function fixture(api, { timeoutMs = 300 } = {}) {
  const parent = mkdtempSync(join(root, '.test-collection-'))
  const dir = join(parent, 'server')
  const bin = join(parent, 'bin')
  mkdirSync(join(dir, 'data'), { recursive: true })
  mkdirSync(bin)
  for (const file of ['cron.sh', 'data.mjs', 'helpers.mjs']) {
    copyFileSync(join(root, file), join(dir, file))
  }
  writeFileSync(
    join(dir, '.env'),
    [
      'DISPLAY_SERVER_PORT=3030',
      'DISPLAY_THEME=random',
      `MEMPOOL_BASE_URL=${api.base}`,
      `DATA_TIMEOUT_MS=${timeoutMs}`,
      `BITCOIN_QUOTES_URL=${api.base}/quotes/random.json`,
      '',
    ].join('\n'),
  )
  writeFileSync(join(dir, 'data', 'display.png'), 'previous display')
  writeFileSync(join(dir, 'data', 'screenshot.png'), 'previous screenshot')
  writeFileSync(
    join(bin, 'firefox-esr'),
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --screenshot=*) target="\${arg#--screenshot=}" ;;
  esac
done
printf '\\211PNG\\r\\n\\032\\n%s' 'fresh browser png' > "$target"
`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(bin, 'pngcrush'),
    `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
printf '\\211PNG\\r\\n\\032\\n%s' 'fresh gray png' > "$last"
`,
    { mode: 0o755 },
  )
  return { parent, dir, bin }
}

// The fake API server runs in this process, so the child has to be spawned
// asynchronously: spawnSync would block the event loop and every request
// would time out against a server that never gets to answer.
function run(fixtureDir, bin, args = [join(fixtureDir, 'cron.sh')]) {
  const inherited = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('DISPLAY_')) inherited[key] = value
  }
  return new Promise((resolve, reject) => {
    const child = spawn('bash', args, {
      cwd: fixtureDir,
      env: { ...inherited, PATH: `${bin}:${inherited.PATH || ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`command timed out\n${stdout}\n${stderr}`))
    }, 60000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      assert.equal(signal, null, `killed by signal: ${signal}`)
      resolve({ status, stdout, stderr })
    })
  })
}

const readData = (f) =>
  JSON.parse(readFileSync(join(f.dir, 'data', 'data.json'), 'utf8'))
const summaryOf = (f) => readData(f).collectionSummary
const diagnostic = (result) => `${result.stdout}\n${result.stderr}`

async function withFixture(options, fn) {
  const api = await fakeApi(options)
  const f = fixture(api, options)
  try {
    return await fn(f, api)
  } finally {
    await api.close()
    rmSync(f.parent, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  }
}

test('all interfaces succeeding yields an all-success collection summary', async () => {
  await withFixture({}, async (f) => {
    const result = await run(f.dir, f.bin)
    assert.equal(result.status, 0, diagnostic(result))

    const summary = summaryOf(f)
    assert.ok(!Number.isNaN(Date.parse(summary.startedAt)))
    assert.deepEqual(
      summary.endpoints.map((entry) => entry.name),
      [...MEMPOOL_ENDPOINTS, 'quote'],
    )
    for (const entry of summary.endpoints) {
      assert.equal(entry.outcome, 'success', `${entry.name}: ${entry.outcome}`)
    }
    assert.equal(summary.successCount, 10)
    assert.equal(summary.failureCount, 0)

    // zero failures must still be reported explicitly
    assert.match(
      result.stdout,
      /^Collection failures: 0 - all interfaces succeeded$/m,
    )

    const data = readData(f)
    assert.equal(data.block.height, HEX)
    assert.deepEqual(data.pools, [{ name: 'pool', blockCount: 10 }])
    assert.deepEqual(
      readFileSync(join(f.dir, 'data', 'display.png')),
      png('fresh gray png'),
    )
  })
})

test('a single HTTP 500 is recorded and reported by cron.sh', async () => {
  await withFixture({ fail: { '/api/v1/mining/pools/1w': 500 } }, async (f) => {
    const result = await run(f.dir, f.bin)
    // a partial outage still renders: only the affected field is null
    assert.equal(result.status, 0, diagnostic(result))

    const summary = summaryOf(f)
    assert.equal(summary.successCount, 9)
    assert.equal(summary.failureCount, 1)
    assert.deepEqual(
      summary.endpoints.filter((e) => e.outcome !== 'success'),
      [{ name: 'mining/pools/1w', outcome: 'http_error', status: 500 }],
    )

    assert.match(
      result.stdout,
      /^Collection failures: 1 - mining\/pools\/1w \(http_error 500\)$/m,
    )

    const data = readData(f)
    assert.equal(data.block.height, HEX)
    assert.equal(data.pools ?? null, null)
    assert.deepEqual(
      readFileSync(join(f.dir, 'data', 'display.png')),
      png('fresh gray png'),
    )
  })
})

test('a single timed-out interface is recorded and reported by cron.sh', async () => {
  await withFixture(
    { hang: ['/api/v1/lightning/nodes/countries'] },
    async (f) => {
      const result = await run(f.dir, f.bin)
      assert.equal(result.status, 0, diagnostic(result))

      const summary = summaryOf(f)
      assert.equal(summary.successCount, 9)
      assert.equal(summary.failureCount, 1)
      assert.deepEqual(
        summary.endpoints.filter((e) => e.outcome !== 'success'),
        [{ name: 'lightning/nodes/countries', outcome: 'timeout' }],
      )

      assert.match(
        result.stdout,
        /^Collection failures: 1 - lightning\/nodes\/countries \(timeout\)$/m,
      )

      const data = readData(f)
      assert.equal(data.block.height, HEX)
      assert.equal(data.lightningCountries ?? null, null)
    },
  )
})

test('malformed JSON and oversized responses get their own outcomes', async () => {
  await withFixture(
    {
      raw: {
        '/api/v1/prices': '{oops',
        '/api/v1/mempool': 'x'.repeat(6 * 1024 * 1024),
      },
    },
    async (f) => {
      // the block still arrives, so the round renders; only these two fields
      // are missing and the summary has to say why
      const result = await run(f.dir, f.bin)
      assert.equal(result.status, 0, diagnostic(result))

      const summary = summaryOf(f)
      assert.equal(summary.failureCount, 2)
      assert.deepEqual(
        summary.endpoints.filter((e) => e.outcome !== 'success'),
        [
          { name: 'prices', outcome: 'json_parse_error', status: 200 },
          { name: 'mempool', outcome: 'response_too_large', status: 200 },
        ],
      )
      assert.match(diagnostic(result), /Collection failures: 2 - prices/)
      assert.deepEqual(
        readFileSync(join(f.dir, 'data', 'display.png')),
        png('fresh gray png'),
      )
    },
  )
})

test('unreachable hosts are recorded as network errors', async () => {
  await withFixture({}, async (f) => {
    // a server that is closed before the run: nothing listens on that port
    const dead = await fakeApi({})
    const deadBase = dead.base
    await dead.close()
    writeFileSync(
      join(f.dir, '.env'),
      [
        'DISPLAY_SERVER_PORT=3030',
        'DISPLAY_THEME=random',
        `MEMPOOL_BASE_URL=${deadBase}`,
        'DATA_TIMEOUT_MS=300',
        `BITCOIN_QUOTES_URL=${deadBase}/quotes/random.json`,
        '',
      ].join('\n'),
    )
    const result = await run(f.dir, f.bin)
    assert.notEqual(result.status, 0, diagnostic(result))

    const summary = summaryOf(f)
    assert.equal(summary.successCount, 0)
    // 10 call sites, plus the /fees/recommended fallback after precise fails
    assert.equal(summary.failureCount, 11)
    assert.deepEqual(
      summary.endpoints.map((entry) => entry.name),
      [...MEMPOOL_ENDPOINTS, 'quote', 'fees/recommended'],
    )
    for (const entry of summary.endpoints) {
      assert.equal(entry.outcome, 'network_error', entry.name)
    }
    assert.match(
      diagnostic(result),
      /Collection failures: 11 - blocks \(network_error\)/,
    )
  })
})

test('an empty blocks response aborts before rendering and keeps the display', async () => {
  await withFixture({ bodies: { '/api/v1/blocks': [] } }, async (f) => {
    const result = await run(f.dir, f.bin)
    assert.notEqual(result.status, 0, diagnostic(result))
    assert.match(diagnostic(result), /Invalid block data/)
    assert.equal(
      readFileSync(join(f.dir, 'data', 'display.png'), 'utf8'),
      'previous display',
    )
    assert.equal(
      readFileSync(join(f.dir, 'data', 'screenshot.png'), 'utf8'),
      'previous screenshot',
    )
  })
})

test('a failed blocks request itself keeps the previous display', async () => {
  await withFixture({ fail: { '/api/v1/blocks': 503 } }, async (f) => {
    const result = await run(f.dir, f.bin)
    assert.notEqual(result.status, 0, diagnostic(result))
    // the summary must still be reported, and it names the real cause
    assert.match(
      diagnostic(result),
      /^Collection failures: 1 - blocks \(http_error 503\)$/m,
    )
    assert.match(diagnostic(result), /Invalid block data/)
    assert.equal(
      readFileSync(join(f.dir, 'data', 'display.png'), 'utf8'),
      'previous display',
    )
  })
})
