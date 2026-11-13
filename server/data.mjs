// Data pipeline: pull live Bitcoin data and write server/data/data.json.
// Runs as part of cron.sh (or manually: `node data.mjs` from server/).
import dotenv from 'dotenv'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'
import { getTheme, writeJSON } from './helpers.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(dir, '.env'), quiet: true })

const { MEMPOOL_BASE_URL, DISPLAY_THEME, DISPLAY_RATE1, DISPLAY_RATE2 } =
  process.env
const isRandomTheme = DISPLAY_THEME === 'random'
const theme = getTheme(DISPLAY_THEME)

// Mempool API: use a local instance when MEMPOOL_BASE_URL is set, otherwise
// fall back to the public mempool.space. A local instance often uses a
// self-signed TLS certificate, so TLS verification is skipped for local
// hosts only; remote endpoints stay verified.
const mempoolDefault = 'https://mempool.space'
const mempoolBase = MEMPOOL_BASE_URL || mempoolDefault

const isLocalUrl = (url) => {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.localhost') ||
      host.startsWith('127.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith('169.254.')
    )
  } catch {
    return false
  }
}
const insecure = isLocalUrl(mempoolBase)

const MAX_BYTES = 5 * 1024 * 1024 // safety cap on response size
const configuredTimeout = Number(process.env.DATA_TIMEOUT_MS)
const TIMEOUT_MS =
  Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 15000

// Every request records how it ended. The collection summary written to
// data/data.json is built from these records, so operators can tell which
// interfaces were missing in a round instead of only seeing null fields.
// Outcomes: success, http_error (non-2xx), timeout, response_too_large,
// json_parse_error, network_error.
const requests = []

const get = (name, url, insecure = false) => {
  // reserve the slot up front so the summary keeps the call order, not the
  // (possibly very different) order in which the responses arrive
  const record = { name, outcome: 'pending' }
  requests.push(record)

  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome, value, status) => {
      if (settled) return
      settled = true
      record.outcome = outcome
      if (Number.isFinite(status)) record.status = status
      resolve(value ?? null)
    }

    const mod = url.startsWith('https:') ? httpsRequest : httpRequest
    let req
    try {
      req = mod(url, { rejectUnauthorized: !insecure }, (res) => {
        const status = res.statusCode
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BYTES) {
            finish('response_too_large', null, status)
            return res.destroy()
          }
          chunks.push(chunk)
        })
        res.on('error', () => finish('network_error', null, status))
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            return finish('http_error', null, status)
          }
          try {
            finish('success', JSON.parse(Buffer.concat(chunks).toString()), status)
          } catch {
            finish('json_parse_error', null, status)
          }
        })
      })
    } catch {
      finish('network_error')
      return
    }
    req.setTimeout(TIMEOUT_MS, () => {
      finish('timeout')
      req.destroy()
    })
    req.on('error', () => finish('network_error'))
    req.end()
  })
}
const mempool = (path) => get(path, `${mempoolBase}/api/v1/${path}`, insecure)
const quoteUrl =
  process.env.BITCOIN_QUOTES_URL || 'https://www.bitcoin-quotes.com/quotes/random.json'

const now = new Date()
const date =
  [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-') +
  ' ' +
  [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join(':')

// Load data based on theme
const wantsLn = isRandomTheme || ['lightning'].includes(theme)
const wantsOnchain = isRandomTheme || ['onchain'].includes(theme)
const wantsMining = isRandomTheme || ['mining'].includes(theme)
const wantsQuote = isRandomTheme || ['plain'].includes(theme)

const startedAt = new Date().toISOString()
const [
  block,
  prices,
  fees,
  mempoolblocks,
  mempoolbacklog,
  pools,
  difficultyAdjustment,
  lightning,
  lightningCountries,
  quote,
] = await Promise.all([
  // the block height always comes from the first record of /blocks
  mempool('blocks').then((blocks) => blocks?.[0] ?? null),
  mempool('prices'),
  // /fees/precise exists only on newer Mempool versions; older ones only
  // serve /fees/recommended, so fall back when precise returns nothing
  wantsOnchain
    ? mempool('fees/precise').then((fees) => fees ?? mempool('fees/recommended'))
    : Promise.resolve(null),
  wantsOnchain ? mempool('fees/mempool-blocks') : Promise.resolve(null),
  wantsMining ? mempool('mempool') : Promise.resolve(null),
  wantsMining ? mempool('mining/pools/1w') : Promise.resolve(null),
  wantsMining ? mempool('difficulty-adjustment') : Promise.resolve(null),
  wantsLn ? mempool('lightning/statistics/latest') : Promise.resolve(null),
  wantsLn ? mempool('lightning/nodes/countries') : Promise.resolve(null),
  wantsQuote ? get('quote', quoteUrl) : Promise.resolve(null),
])

const rateOf = (code) => {
  const value = prices?.[code]
  return { code, ...(value ? { rate: value } : {}) }
}

const rates = [DISPLAY_RATE1, DISPLAY_RATE2].filter(Boolean).map(rateOf)

const failed = requests.filter((r) => r.outcome !== 'success')
const summary = {
  startedAt,
  endpoints: requests,
  successCount: requests.length - failed.length,
  failureCount: failed.length,
}

const data = {
  date,
  block,
  rates,
  quote,
  fees,
  mempoolbacklog,
  mempoolblocks,
  difficultyAdjustment,
  lightning,
  lightningCountries: lightningCountries?.slice(0, 3),
  pools: pools?.pools.slice(0, 5),
  collectionSummary: summary,
}

writeJSON('data/data', data)
