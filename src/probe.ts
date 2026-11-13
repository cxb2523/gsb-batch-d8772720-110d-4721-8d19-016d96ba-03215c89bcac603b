/**
 * 宿主外部采集（余额 / 实时汇率）——逐源结局。
 *
 * 两条链路都只回答一个问题：「这次请求到底试了哪些源，每个源的结局是什么？」
 * 因此每次尝试都写入一条 `SourceAttempt`（按实际尝试顺序）：脱敏后的源地址、
 * 结局类型、HTTP 状态（仅 HTTP 非 2xx）、耗时与可读原因。整体 `ok` 仍只表示
 * 是否拿到可用结果；多源回退时命中即停，全部失败时保留每一条结局。
 *
 * 安全约束：
 *  - 只由宿主发起 GET；API Key 只放在 Authorization 头，绝不写入响应或日志；
 *  - 源地址在进入响应前脱敏：去掉 userinfo，敏感查询参数值替换为 `***`；
 *  - 可读原因在返回前清除密钥字面量；
 *  - 每次外部请求独立超时，任何失败都结构化返回，不抛异常。
 */

export type ProbeOutcome = 'success' | 'http-error' | 'timeout' | 'network-error' | 'bad-response'

/** 一次外部源尝试的可核对记录（按实际尝试顺序排列）。 */
export interface SourceAttempt {
  /** 实际尝试顺序，从 0 开始。 */
  index: number
  /** 已脱敏的源地址：不含凭据，敏感查询参数值为 `***`。 */
  url: string
  outcome: ProbeOutcome
  /** 仅 `http-error` 时给出。 */
  status?: number
  /** 本次尝试耗时（毫秒，非负）。 */
  durationMs: number
  /** 可读原因（失败时）；已清除密钥字面量。 */
  message?: string
}

export interface BalanceInfo {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

export interface BalanceResponse {
  /** 是否拿到可用的余额结果。 */
  ok: boolean
  apiKeyConfigured: boolean
  source?: 'api'
  /** 兼容旧客户端的粗粒度原因；逐源细节见 `attempts`。 */
  reason?: 'no-api-key' | 'request-failed' | 'bad-response'
  message?: string
  isAvailable?: boolean
  balances?: BalanceInfo[]
  /** 按实际尝试顺序排列的逐源结局（未配置密钥时为空）。 */
  attempts: SourceAttempt[]
}

export interface RateResponse {
  ok: boolean
  rate?: number
  fetchedAt?: number
  /** 命中的源地址（已脱敏）。 */
  source?: string
  /** 命中源在 `attempts` 中的顺序。 */
  sourceIndex?: number
  /** 兼容旧客户端的粗粒度原因；逐源细节见 `attempts`。 */
  reason?: 'request-failed' | 'bad-response'
  message?: string
  /** 按实际尝试顺序排列的逐源结局；命中后不再尝试后续源。 */
  attempts: SourceAttempt[]
}

export interface ProbeOptions {
  /** 便于测试注入的 fetch 实现；默认全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 单个外部请求的超时（毫秒）；默认 8 秒。 */
  timeoutMs?: number
}

export const DEFAULT_PROBE_TIMEOUT_MS = 8_000

/** 敏感查询参数名（宁可多脱敏，也不能外泄）。 */
const SENSITIVE_QUERY_NAME = /(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd|auth|signature|sig|credential|session|key)/i

/** 脱敏源地址：去掉 userinfo / fragment，敏感查询参数值替换为 `***`。 */
export function redactSourceUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value.replace(/\/\/[^/@]*@/, '//')
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_NAME.test(name)) url.searchParams.set(name, '***')
  }
  return url.toString()
}

/** 从可读文本中清除密钥字面量（防御性：上游回显或错误消息带出密钥）。 */
export function scrubSecrets(value: string, secrets: readonly string[]): string {
  let out = value
  for (const secret of secrets) {
    if (secret.length < 6) continue
    out = out.split(secret).join('***')
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(Date.now() - startedAt))
}

function isAbort(error: unknown, timedOut: boolean, controller: AbortController): boolean {
  if (timedOut || controller.signal.aborted) return true
  return isRecord(error) && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** JSON 语法错误（响应体不是合法 JSON）与读体期间的网络中断要分开归类。 */
function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError
}

function describeAttempt(attempt: SourceAttempt): string {
  switch (attempt.outcome) {
    case 'success': return '成功'
    case 'http-error': return attempt.status === undefined ? 'HTTP 错误' : `HTTP ${attempt.status}`
    case 'timeout': return '超时'
    case 'network-error': return '网络错误'
    case 'bad-response': return '响应结构非法'
  }
}

/**
 * 错误消息可能回显完整源 URL（含敏感查询值）：把原文替换为脱敏后的地址，
 * 保证 `message` 与 `url` 字段不会泄露查询串里的凭据。
 */
function sanitizeSourceMessage(message: string, rawSource: string, redacted: string): string {
  if (rawSource === redacted) return message
  return message.split(rawSource).join(redacted)
}

/**
 * 拉取官方余额。任何失败都返回结构化错误（含一条逐源结局），不抛异常。
 * `apiKey` 只用于 Authorization 头，且会在返回前从所有可读文本中清除。
 */
export async function probeBalance(
  apiKey: string,
  baseUrl: string,
  options: ProbeOptions = {},
): Promise<BalanceResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const url = `${baseUrl}/user/balance`
  const startedAt = Date.now()
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const failure = (outcome: ProbeOutcome, message: string, status?: number): BalanceResponse => {
    const clean = scrubSecrets(message, [apiKey])
    return {
      ok: false,
      apiKeyConfigured: true,
      reason: outcome === 'bad-response' ? 'bad-response' : 'request-failed',
      message: clean,
      attempts: [{
        index: 0,
        url: redactSourceUrl(url),
        outcome,
        durationMs: elapsedSince(startedAt),
        ...(status === undefined ? {} : { status }),
        message: clean,
      }],
    }
  }

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      const status = typeof res.status === 'number' ? res.status : undefined
      return failure('http-error', `官方接口返回 HTTP ${status ?? '错误'}`, status)
    }
    let data: unknown
    try {
      data = await res.json()
    } catch (error) {
      if (isAbort(error, timedOut, controller)) throw error
      if (isJsonParseError(error)) return failure('bad-response', '官方接口响应不是合法 JSON')
      return failure('network-error', `读取官方接口响应失败：${errorMessage(error)}`)
    }
    const record = isRecord(data) ? data : undefined
    const infos = record?.balance_infos
    if (!Array.isArray(infos)) {
      return failure('bad-response', '官方接口响应缺少 balance_infos 字段')
    }
    const balances: BalanceInfo[] = infos
      .filter(isRecord)
      .map((b) => ({
        currency: typeof b.currency === 'string' && b.currency !== '' ? b.currency : 'CNY',
        totalBalance: typeof b.total_balance === 'string' ? b.total_balance : '0',
        grantedBalance: typeof b.granted_balance === 'string' ? b.granted_balance : '0',
        toppedUpBalance: typeof b.topped_up_balance === 'string' ? b.topped_up_balance : '0',
      }))
    if (balances.length === 0) {
      return failure('bad-response', '官方接口未返回 balance_infos')
    }
    return {
      ok: true,
      apiKeyConfigured: true,
      source: 'api',
      isAvailable: record?.is_available === true,
      balances,
      attempts: [{
        index: 0,
        url: redactSourceUrl(url),
        outcome: 'success',
        durationMs: elapsedSince(startedAt),
      }],
    }
  } catch (error) {
    if (isAbort(error, timedOut, controller)) {
      return failure('timeout', `请求官方接口超时（${timeoutMs} 毫秒）`)
    }
    return failure('network-error', `请求官方接口失败：${errorMessage(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉取实时 USD→CNY 汇率：按 `fxUrls` 顺序依次尝试，每个源独立超时；
 * 任一源返回合法 `rates.CNY` 即成功、停止回退并标注命中源。全部失败时
 * 保留每一个源的结局，返回结构化错误而不抛异常。
 */
export async function probeRate(
  fxUrls: readonly string[],
  options: ProbeOptions = {},
): Promise<RateResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const attempts: SourceAttempt[] = []
  let lastReason: 'request-failed' | 'bad-response' = 'request-failed'

  for (let index = 0; index < fxUrls.length; index += 1) {
    const source = fxUrls[index]
    const redacted = redactSourceUrl(source)
    const startedAt = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    // 记录一条结局：消息里若回显了完整源地址，替换为脱敏版本（查询串不外泄）。
    const record = (outcome: ProbeOutcome, message: string | undefined, status?: number): void => {
      attempts.push({
        index,
        url: redacted,
        outcome,
        ...(status === undefined ? {} : { status }),
        durationMs: elapsedSince(startedAt),
        ...(message === undefined ? {} : { message: sanitizeSourceMessage(message, source, redacted) }),
      })
    }

    try {
      const res = await fetchImpl(source, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) {
        const status = typeof res.status === 'number' ? res.status : undefined
        record('http-error', `汇率源返回 HTTP ${status ?? '错误'}`, status)
        lastReason = 'request-failed'
        continue
      }
      let data: unknown
      try {
        data = await res.json()
      } catch (error) {
        if (isAbort(error, timedOut, controller)) throw error
        const parseError = isJsonParseError(error)
        record(
          parseError ? 'bad-response' : 'network-error',
          parseError ? '汇率源响应不是合法 JSON' : `读取汇率源响应失败：${errorMessage(error)}`,
        )
        lastReason = parseError ? 'bad-response' : 'request-failed'
        continue
      }
      const rate = isRecord(data) && isRecord(data.rates) ? data.rates.CNY : undefined
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        record('bad-response', '汇率源未返回有效的 rates.CNY')
        lastReason = 'bad-response'
        continue
      }
      record('success', undefined)
      return {
        ok: true,
        rate,
        fetchedAt: Date.now(),
        source: redacted,
        sourceIndex: index,
        attempts,
      }
    } catch (error) {
      const aborted = isAbort(error, timedOut, controller)
      record(
        aborted ? 'timeout' : 'network-error',
        aborted
          ? `汇率源请求超时（${timeoutMs} 毫秒）`
          : `汇率源请求失败：${errorMessage(error)}`,
      )
      lastReason = 'request-failed'
    } finally {
      clearTimeout(timer)
    }
  }

  const summary = attempts.map((attempt) => `${attempt.url} → ${describeAttempt(attempt)}`).join('；')
  return {
    ok: false,
    reason: lastReason,
    message: attempts.length === 0 ? '没有可用的汇率源' : `全部 ${attempts.length} 个汇率源均失败：${summary}`,
    attempts,
  }
}
