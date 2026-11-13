/**
 * 宿主（Node）半区：dsh-usage-chart
 *
 * 在同源 HTTP 服务上注册五个路由：
 *  - `/dsh-usage-chart/balance` — 代理 DeepSeek 官方 `GET /user/balance`
 *    （浏览器直连会被 CORS 拦截，且 API Key 不应暴露给浏览器）。
 *  - `/dsh-usage-chart/usage`   — 读取会话日志（adapter 上报的完整事件流），
 *    经 RoundFold 折叠出每轮用量明细（token 四桶 + 耗时/TTFT/TPS +
 *    模型归因 + 结束原因 + 每轮成本分拆）。
 *  - `/dsh-usage-chart/pricing` — 价格解析快照（内置刊例价 + 用户覆盖
 *    pricing.json，CNY/USD 双币种 / 1M tokens，区分高峰/空闲时段），client 实时
 *    成本计算的唯一价格输入（ADR 2）。
 *  - `/dsh-usage-chart/meta`    — 下发成本显示币种与汇率配置（成本按所选币种的
 *    官方刊例价直接计算，汇率仅作参考注记）。
 *  - `/dsh-usage-chart/rate`    — 代理实时 USD→CNY 汇率查询（多源按序回退）。
 *
 * 余额与汇率的外部采集由 `probe.ts` 完成：每次响应都带按实际尝试顺序排列的
 * `attempts`（脱敏源地址 / 结局 / 耗时），整体 `ok` 只表示是否拿到可用结果。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, CredentialsService } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeCnyPerUsd, normalizeCurrency } from './pricing/calc.ts'
import { DEFAULT_PROBE_TIMEOUT_MS, probeBalance, probeRate } from './probe.ts'
import type { BalanceResponse, ProbeOptions } from './probe.ts'
export { probeBalance, probeRate, redactSourceUrl, scrubSecrets } from './probe.ts'
export type { BalanceInfo, BalanceResponse, ProbeOutcome, RateResponse, SourceAttempt } from './probe.ts'

// ── 共享纯计算（client 同源 bundle）────────────────────────────────────────
export {
  ZERO_BUCKETS,
  billedInputTokens,
  cacheHitPercent,
  DEFAULT_CNY_PER_USD,
  costSplit,
  costSplitAt,
  formatCny,
  formatDuration,
  formatMoney,
  formatPricePerM,
  formatTokens,
  isPeakHour,
  isUnpricedWhenUnknown,
  matchPricingKey,
  normalizeCnyPerUsd,
  normalizeCurrency,
  normalizeModelId,
  pricingAtRate,
  tierAt,
  UNPRICED_PRICING,
} from './pricing/calc.ts'
export type {
  BucketPrices,
  CostCurrency,
  CostSplit,
  ModelPricing,
  PriceTier,
  PriceTierId,
  TokenUsageBuckets,
} from './pricing/calc.ts'

// ── 价格来源接缝与解析器（host 专用）───────────────────────────────────────
import {
  BUILTIN_VERIFIED_AT,
  FALLBACK_PRICING,
  filePricingSource,
} from './pricing/source.ts'
import { createPricingResolver } from './pricing/resolve.ts'
import { foldRounds, type SessionEventLike } from './usage/rounds.ts'
import { foldCompactions } from './usage/compactions.ts'

export {
  ANTHROPIC_PRICING,
  ANTHROPIC_VERIFIED_AT,
  BUILTIN_PRICING,
  BUILTIN_VERIFIED_AT,
  FALLBACK_PRICING,
  builtinPricingSource,
  filePricingSource,
  loadPricingFile,
  normalizeFileEntry,
  parsePricingFile,
} from './pricing/source.ts'
export type { FilePricingEntry, PricingFileShape, PricingSource, PricingSourceId } from './pricing/source.ts'
export { createPricingResolver, estimateCost, pricingFor } from './pricing/resolve.ts'
export type { PricingResolver, ResolvedPricing } from './pricing/resolve.ts'

/** v0.1 兼容别名：内置刊例价表。 */
export { BUILTIN_PRICING as PRICING } from './pricing/source.ts'

// ── RoundFold（host 折叠，权威基准）────────────────────────────────────────
export { foldRounds, foldTurnUsage } from './usage/rounds.ts'
export type { FoldResult, RoundCost, SessionEventLike, UsageRound } from './usage/rounds.ts'
export { foldCompactions } from './usage/compactions.ts'
export type { CompactionRecord } from './usage/compactions.ts'

export const name = 'dsh-usage-chart'

/** 依赖 webServer（路由载体）与 sessions（会话日志读取）。 */
export const inject = ['webServer', 'sessions']

export interface Config {
  /** 可选：优先于环境变量 DEEPSEEK_API_KEY。留空则回退到环境变量。 */
  apiKey?: string
  /** 可选：官方 API 基地址。 */
  baseUrl?: string
  /**
   * 可选：价格覆盖文件（pricing.json）路径。留空时默认
   * `$DSH_HOME/data/dsh-usage-chart/pricing.json`（无 DSH_HOME 时 `~/.dsh/...`）。
   */
  pricingFile?: string
  /** 可选：成本显示币种，'usd'（默认）或 'cny'。 */
  currency?: string
  /** 单币种报价的统一 USD→CNY 展示汇率，默认 6.76；显式双币种原价不受影响。 */
  cnyPerUsd?: number
  /** 可选：实时汇率数据源 URL（须返回 `{ rates: { CNY: number } }` 结构），默认 open.er-api.com。 */
  fxUrl?: string
  /** 可选：单个外部请求（余额 / 每个汇率源）的超时毫秒数，默认 8000。 */
  timeoutMs?: number
  /** 测试接缝：替换外部 fetch 实现（默认全局 fetch）。 */
  fetchImpl?: typeof fetch
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'

const DEFAULT_FX_URL = 'https://open.er-api.com/v6/latest/USD'

/**
 * 验证并规茁化汇率源 URL：强制 HTTPS（仅 loopback 放行 HTTP）、禁凭据；
 * 与 normalizeBaseUrl 不同，保留 query 参数（汇率源常需 ?from=USD / ?base=USD）。
 */
function normalizeFxUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('dsh-usage-chart: config.fxUrl must be an absolute URL')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('dsh-usage-chart: config.fxUrl must use HTTPS (HTTP is only allowed for loopback proxies)')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('dsh-usage-chart: config.fxUrl must not contain credentials')
  }
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

/** 回退汇率源（主源不可达时依次尝试；结构须为 `{ rates: { CNY: number } }`）。 */
const FALLBACK_FX_URLS = [
  'https://api.frankfurter.dev/v1/latest?base=USD',
]

/** 默认价格覆盖文件：`$DSH_HOME/data/dsh-usage-chart/pricing.json`。 */
export function defaultPricingFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.DSH_HOME?.trim()
  const root = configured !== undefined && configured !== '' ? expandHome(configured, home) : join(home, '.dsh')
  return join(root, 'data', 'dsh-usage-chart', 'pricing.json')
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

/**
 * Normalize and validate the upstream API URL.
 * HTTPS is required except for loopback addresses used by local API proxies.
 */
export function normalizeBaseUrl(value: string | undefined): string {
  const candidate = value?.trim() || DEFAULT_BASE_URL
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new TypeError('dsh-usage-chart: config.baseUrl must be an absolute URL')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('dsh-usage-chart: config.baseUrl must use HTTPS (HTTP is only allowed for loopback proxies)')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('dsh-usage-chart: config.baseUrl must not contain credentials')
  }
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

/** Reject browser requests initiated outside the DSH Web origin. */
export function isTrustedRequest(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false
  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') return false

  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin === 'string' && typeof host === 'string') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

function guardRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    writeJson(res, 405, { ok: false, reason: 'method-not-allowed' })
    return false
  }
  if (!isTrustedRequest(req)) {
    writeJson(res, 403, { ok: false, reason: 'cross-origin-request' })
    return false
  }
  return true
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(payload)
}

/**
 * 插件入口：注册余额代理 / 用量折叠 / 价格快照 / 显示配置 / 汇率代理路由。
 * @param ctx - 宿主 Context（cordis）。
 * @param config - 行配置（cordis.patch.yml 的 config）。
 */
export function apply(ctx: Context, config: Config = {}): void {
  /**
   * 解析 API Key（每次请求解析，与官方 llm-deepseek 适配器同一通道）：
   *  1) 插件 config.apiKey（显式配置优先）
   *  2) DSH 凭据服务解析 'DEEPSEEK_API_KEY'——覆盖在网页端「设置 → 模型」
   *     配置的密钥、用户/项目环境层与 $DEEPSEEK_API_KEY。凭据服务是可选
   *     依赖，用 ctx.get('credentials') 读取（不声明 inject，缺失返回
   *     undefined；cordis 属性访问未 inject 的服务会抛错）。
   *  3) 无凭据服务时回退 process.env.DEEPSEEK_API_KEY
   */
  const resolveApiKey = async (): Promise<string> => {
    const configured = config.apiKey?.trim()
    if (configured !== undefined && configured !== '') return configured
    const credentials = ctx.get('credentials') as CredentialsService | undefined
    if (credentials !== undefined) {
      const resolved = await credentials.resolve('DEEPSEEK_API_KEY')
      const value = resolved?.value.trim()
      if (value !== undefined && value !== '') return value
    }
    return (process.env.DEEPSEEK_API_KEY ?? '').trim()
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  // 每次外部请求独立超时；测试可经 config.fetchImpl 注入本地伪造 fetch。
  const timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS
  const probeOptions: ProbeOptions = {
    timeoutMs,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  }

  // 价格解析（单一真相）：用户覆盖文件（含变更监听）→ 内置刊例价 → 回退。
  const pricingFile = config.pricingFile?.trim() || defaultPricingFile()
  const fileSource = filePricingSource(pricingFile)
  const cnyPerUsd = normalizeCnyPerUsd(config.cnyPerUsd)
  const resolver = createPricingResolver(fileSource, cnyPerUsd)
  // 注意返回的是「返回 disposer 的函数」：写成 () => fileSource.dispose() 会在注册时立刻销毁文件源。
  ctx.effect(() => () => fileSource.dispose(), 'dsh-usage-chart: pricing file watcher')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-usage-chart/balance',
    async handler(req: IncomingMessage, res: ServerResponse) {
      if (!guardRequest(req, res)) return
      const apiKey = await resolveApiKey()
      if (apiKey === '') {
        writeJson(res, 200, {
          ok: false,
          apiKeyConfigured: false,
          reason: 'no-api-key',
          message: '未配置 DEEPSEEK_API_KEY（或插件 config.apiKey / 网页端 API Key）。余额显示为 –，点击可重试。',
          attempts: [],
        } satisfies BalanceResponse)
        return
      }
      const result = await probeBalance(apiKey, baseUrl, probeOptions)
      writeJson(res, 200, result)
    },
  }), 'dsh-usage-chart: balance route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-usage-chart/usage',
    async handler(req: IncomingMessage, res: ServerResponse) {
      if (!guardRequest(req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('session') ?? ''
      if (!/^session-[\w-]+$/.test(sessionId)) {
        writeJson(res, 400, { ok: false, reason: 'bad-session-id' })
        return
      }
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) {
        writeJson(res, 404, { ok: false, reason: 'session-not-found' })
        return
      }
      // dsh-session >= 0.1.2-rc.1 removed the `events` property; prefer the
      // public snapshotEvents() API and fall back to the legacy property.
      const events: readonly SessionEventLike[] = typeof session.snapshotEvents === 'function'
        ? session.snapshotEvents()
        : session.events ?? []
      // 汇率只是展示参数，不写回会话。当前页面的历史、压缩、实时估算共用它；
      // 非法/缺失值回退配置，不能让不同标签页刷新汇率互相修改全局价格。
      const requestedRate = Number(url.searchParams.get('cnyPerUsd'))
      const displayRate = Number.isFinite(requestedRate) && requestedRate > 0 ? requestedRate : cnyPerUsd
      const displayResolver = createPricingResolver(fileSource, displayRate)
      const { totals, rounds } = foldRounds(events, displayResolver)
      const compactions = foldCompactions(events, displayResolver)
      writeJson(res, 200, { ok: true, sessionId, totals, rounds, compactions })
    },
  }), 'dsh-usage-chart: usage route')

  const displayCurrency = normalizeCurrency(config.currency)
  // 汇率源列表：配置源（或默认源） + 内置回退源，去重后依次尝试
  const configuredFxUrl = config.fxUrl?.trim() ?? ''
  const fxUrls = [...new Set([
    configuredFxUrl === '' ? DEFAULT_FX_URL : normalizeFxUrl(configuredFxUrl),
    ...FALLBACK_FX_URLS,
  ])]

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-usage-chart/meta',
    async handler(req: IncomingMessage, res: ServerResponse) {
      if (!guardRequest(req, res)) return
      writeJson(res, 200, { ok: true, currency: displayCurrency, cnyPerUsd })
    },
  }), 'dsh-usage-chart: meta route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-usage-chart/rate',
    async handler(req: IncomingMessage, res: ServerResponse) {
      if (!guardRequest(req, res)) return
      const result = await probeRate(fxUrls, probeOptions)
      writeJson(res, 200, result)
    },
  }), 'dsh-usage-chart: rate route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-usage-chart/pricing',
    async handler(req: IncomingMessage, res: ServerResponse) {
      if (!guardRequest(req, res)) return
      writeJson(res, 200, {
        ok: true,
        pricingFile,
        builtinVerifiedAt: BUILTIN_VERIFIED_AT,
        fallback: {
          pricing: FALLBACK_PRICING,
          verifiedAt: BUILTIN_VERIFIED_AT,
        },
        models: resolver.list(),
      })
    },
  }), 'dsh-usage-chart: pricing route')
}
