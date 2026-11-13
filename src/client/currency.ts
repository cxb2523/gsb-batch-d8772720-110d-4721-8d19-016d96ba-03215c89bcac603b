/**
 * client 成本显示币种状态（PR #5 移植）。
 *
 * 数据流：/dsh-usage-chart/meta（config 币种 + 汇率）→ 模块级 store；
 * 用户切换（USD/CNY）写入 localStorage 覆盖 config 默认；「刷新汇率」经
 * /dsh-usage-chart/rate 拉到实时汇率并保存上次成功值。历史请求与所有换算消费方经
 * useDisplayCurrency()（useSyncExternalStore）读取。
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_CNY_PER_USD, type CostCurrency } from '../pricing/calc.ts'
import type { ProbeOutcome, SourceAttempt } from './attempts.tsx'

export interface DisplayMeta {
  currency: CostCurrency
  cnyPerUsd: number
  rateSource?: 'config' | 'live'
  rateFetchedAt?: number
  /** 最近一次刷新汇率的逐源结局（旧宿主没有该字段时为空）。 */
  rateAttempts?: SourceAttempt[]
  /** 命中的汇率源（成功时，已脱敏）。 */
  rateAttemptSource?: string
  /** 全部失败时的可读原因。 */
  rateMessage?: string
}

export type RateRefreshResult = 'ok' | 'request-failed' | 'bad-response'

/** 最近一次汇率刷新的逐源结局（供面板展示；旧响应可能为空）。 */
export interface RateAttemptReport {
  /** 旧宿主没有该字段时为 undefined（页面沿用原提示，不渲染逐源列表）。 */
  attempts?: SourceAttempt[]
  /** 命中的源地址（成功时）；旧响应的 `source` 也映射到这里。 */
  source?: string
  /** 全部失败时的可读原因。 */
  message?: string
}

function publishRateReport(report: RateAttemptReport | null): void {
  meta = {
    ...meta,
    ...(report === null
      ? { rateAttempts: undefined, rateAttemptSource: undefined, rateMessage: undefined }
      : {
          rateAttempts: report.attempts,
          rateAttemptSource: report.source,
          rateMessage: report.message,
        }),
  }
  notify()
}

/** 只接受结构合法的逐源结局；旧宿主缺失该字段时返回 undefined。 */
function parseAttempts(value: unknown): SourceAttempt[] | undefined {
  if (!Array.isArray(value)) return undefined
  const outcomes: ProbeOutcome[] = ['success', 'http-error', 'timeout', 'network-error', 'bad-response']
  return value.flatMap((item, position) => {
    if (typeof item !== 'object' || item === null) return []
    const attempt = item as Record<string, unknown>
    if (typeof attempt.url !== 'string' || typeof attempt.outcome !== 'string') return []
    if (!outcomes.includes(attempt.outcome as ProbeOutcome)) return []
    return [{
      index: typeof attempt.index === 'number' && Number.isFinite(attempt.index) ? attempt.index : position,
      url: attempt.url,
      outcome: attempt.outcome as ProbeOutcome,
      ...(typeof attempt.status === 'number' ? { status: attempt.status } : {}),
      durationMs: typeof attempt.durationMs === 'number' && Number.isFinite(attempt.durationMs) ? attempt.durationMs : 0,
      ...(typeof attempt.message === 'string' ? { message: attempt.message } : {}),
    }]
  })
}

const STORAGE_KEY = 'dsh-usage-chart:currency'
/** 上次成功汇率的持久化：刷新失败时用它代替固定默认值，避免“不能正确计算”。 */
const RATE_STORAGE_KEY = 'dsh-usage-chart:rate'
const DEFAULT_META: DisplayMeta = { currency: 'usd', cnyPerUsd: DEFAULT_CNY_PER_USD, rateSource: 'config' }

let meta: DisplayMeta = DEFAULT_META
let userChosen = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function storedCurrency(): CostCurrency | null {
  try {
    const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    return value === 'cny' || value === 'usd' ? value : null
  } catch {
    return null
  }
}

export function getDisplayMeta(): DisplayMeta {
  return meta
}

export function subscribeDisplayMeta(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useDisplayCurrency(): DisplayMeta {
  // 第三个参数为 SSR/静态渲染快照：缺少它时 renderToStaticMarkup 会直接抛错。
  return useSyncExternalStore(subscribeDisplayMeta, getDisplayMeta, getDisplayMeta)
}

export function setDisplayCurrency(currency: CostCurrency): void {
  userChosen = true
  if (meta.currency === currency) return
  meta = { ...meta, currency }
  try {
    localStorage.setItem(STORAGE_KEY, currency)
  } catch {
    // ignore
  }
  notify()
}

export async function fetchDisplayMeta(): Promise<void> {
  try {
    const res = await fetch('/dsh-usage-chart/meta', { headers: { Accept: 'application/json' } })
    if (!res.ok) return
    const body = (await res.json()) as { ok?: boolean; currency?: string; cnyPerUsd?: number }
    if (body.ok !== true) return
    const currency: CostCurrency = body.currency === 'cny' ? 'cny' : 'usd'
    const cnyPerUsd =
      typeof body.cnyPerUsd === 'number' && Number.isFinite(body.cnyPerUsd) && body.cnyPerUsd > 0
        ? body.cnyPerUsd
        : DEFAULT_CNY_PER_USD
    // 唯一展示汇率：上次成功/新刷新的实时值优先于配置；但持久化汇率
    // 不应阻止从 /meta 初始化币种。币种和汇率分别合并，避免互相覆盖。
    const nextCurrency = userChosen ? meta.currency : currency
    const nextRate = meta.rateSource === 'live' ? meta.cnyPerUsd : cnyPerUsd
    if (meta.currency !== nextCurrency || meta.cnyPerUsd !== nextRate) {
      meta = { ...meta, currency: nextCurrency, cnyPerUsd: nextRate }
      notify()
    }
  } catch {
    // ignore
  }
}

function storedRateMeta(): { rate: number; fetchedAt: number } | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(RATE_STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { rate?: unknown; fetchedAt?: unknown }
    if (typeof parsed.rate === 'number' && Number.isFinite(parsed.rate) && parsed.rate > 0
      && typeof parsed.fetchedAt === 'number' && Number.isFinite(parsed.fetchedAt) && parsed.fetchedAt >= 0) {
      return { rate: parsed.rate, fetchedAt: parsed.fetchedAt }
    }
    return null
  } catch {
    return null
  }
}

export function setLiveRate(rate: number, fetchedAt: number): void {
  // 所有消费方只接受这一个已校验的展示汇率，不允许 NaN/负值污染历史成本。
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(fetchedAt) || fetchedAt < 0) return
  if (meta.currency === 'cny' && meta.cnyPerUsd === rate && meta.rateSource === 'live' && meta.rateFetchedAt === fetchedAt) return
  meta = { ...meta, cnyPerUsd: rate, rateSource: 'live', rateFetchedAt: fetchedAt }
  try {
    localStorage.setItem(RATE_STORAGE_KEY, JSON.stringify({ rate, fetchedAt }))
  } catch {
    // ignore
  }
  notify()
}

export async function refreshLiveRate(): Promise<RateRefreshResult> {
  try {
    const res = await fetch('/dsh-usage-chart/rate', { headers: { Accept: 'application/json' } })
    const body = (await res.json()) as {
      ok?: boolean
      rate?: unknown
      fetchedAt?: unknown
      reason?: string
      source?: unknown
      message?: unknown
      attempts?: unknown
    }
    const attempts = parseAttempts(body.attempts)
    const source = typeof body.source === 'string' ? body.source : undefined
    const message = typeof body.message === 'string' ? body.message : undefined
    if (body.ok === true && typeof body.rate === 'number' && Number.isFinite(body.rate) && body.rate > 0) {
      setLiveRate(body.rate, typeof body.fetchedAt === 'number' && Number.isFinite(body.fetchedAt) && body.fetchedAt >= 0 ? body.fetchedAt : Date.now())
      publishRateReport({ ...(attempts === undefined ? {} : { attempts }), source, message })
      return 'ok'
    }
    publishRateReport({ ...(attempts === undefined ? {} : { attempts }), source, message })
    return body.reason === 'bad-response' ? 'bad-response' : 'request-failed'
  } catch {
    // 请求本身失败：清空逐源结局，页面回退到粗粒度提示（保持旧行为）。
    publishRateReport(null)
    return 'request-failed'
  }
}

export function initDisplayMeta(): void {
  const stored = storedCurrency()
  if (stored !== null) {
    userChosen = true
    meta = { ...meta, currency: stored }
  }
  // 恢复上次成功汇率（如有）：异常时用它代替配置默认值
  const storedRate = storedRateMeta()
  if (storedRate !== null) {
    meta = { ...meta, cnyPerUsd: storedRate.rate, rateSource: 'live', rateFetchedAt: storedRate.fetchedAt }
  }
  void fetchDisplayMeta()
}
