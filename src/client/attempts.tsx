/**
 * 逐源采集结局的展示（余额 / 汇率共用）。
 *
 * 只消费宿主下发的已脱敏 `SourceAttempt[]`：按尝试顺序列出源地址、结局与耗时。
 * 旧响应没有该字段时返回 null，调用方保持原有展示、不报错。
 */
import type { ProbeOutcomeName, UiCopy } from './i18n.ts'

export type ProbeOutcome = ProbeOutcomeName

/** 单个外部源的尝试结局（顺序即宿主实际尝试顺序）。旧宿主可能没有该字段。 */
export interface SourceAttempt {
  index: number
  url: string
  outcome: ProbeOutcome
  status?: number
  durationMs: number
  message?: string
}

export interface AttemptRow {
  index: number
  url: string
  outcome: string
  durationMs: number
  status?: number
  message?: string
}

export interface AttemptsView {
  rows: AttemptRow[]
  /** 成功命中源（若有）。 */
  hit?: string
}

/** 结构校验：只接受可核对的条目，顺序与宿主实际尝试顺序一致。 */
export function toAttemptsView(value: unknown): AttemptsView | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const rows: AttemptRow[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const attempt = item as Record<string, unknown>
    if (typeof attempt.url !== 'string' || typeof attempt.outcome !== 'string') continue
    rows.push({
      index: typeof attempt.index === 'number' && Number.isFinite(attempt.index) ? attempt.index : rows.length,
      url: attempt.url,
      outcome: attempt.outcome,
      durationMs: typeof attempt.durationMs === 'number' && Number.isFinite(attempt.durationMs) ? attempt.durationMs : 0,
      ...(typeof attempt.status === 'number' ? { status: attempt.status } : {}),
      ...(typeof attempt.message === 'string' ? { message: attempt.message } : {}),
    })
  }
  if (rows.length === 0) return null
  // 按宿主给出的 index 排序（缺省 index 保持原顺序），保证「实际尝试顺序」可核对。
  rows.sort((a, b) => a.index - b.index)
  const hit = rows.find((row) => row.outcome === 'success')
  return { rows, ...(hit === undefined ? {} : { hit: hit.url }) }
}

const KNOWN_OUTCOMES: readonly ProbeOutcomeName[] = ['success', 'http-error', 'timeout', 'network-error', 'bad-response']

/** CSS 类名只使用已知结局，避免把任意服务端字符串拼进 class。 */
function outcomeClass(outcome: string): string {
  return KNOWN_OUTCOMES.includes(outcome as ProbeOutcomeName) ? outcome : 'unknown'
}

export interface AttemptsListProps {
  view: AttemptsView
  copy: UiCopy
  testId?: string
}

/** 逐源结局列表：`<ol>` 保持尝试顺序，端点即结果。 */
export function AttemptsList({ view, copy, testId }: AttemptsListProps): JSX.Element {
  return (
    <div className="duc-attempts" data-testid={testId}>
      <div className="duc-attempts-title">{copy.attemptsTitle}</div>
      <ol className="duc-attempts-list">
        {view.rows.map((row) => {
          const outcome = copy.attemptOutcome(row.outcome as ProbeOutcomeName)
          const detail = row.message !== undefined && row.message !== ''
            ? copy.attemptErrorDetail(row.status, row.message)
            : (row.status === undefined ? '' : `HTTP ${row.status}`)
          return (
            <li
              key={`${row.index}:${row.url}`}
              className={`duc-attempt duc-attempt-${outcomeClass(row.outcome)}`}
              title={detail === '' ? copy.attemptLine(row.url, outcome, copy.attemptDuration(row.durationMs))
                : copy.attemptLine(row.url, outcome, copy.attemptDuration(row.durationMs)) + ' · ' + detail}
            >
              <span className="duc-attempt-url">{row.url}</span>
              <span className="duc-attempt-outcome">{outcome}</span>
              <span className="duc-attempt-time">{copy.attemptDuration(row.durationMs)}</span>
            </li>
          )
        })}
      </ol>
      {view.hit !== undefined && <div className="duc-attempts-hit">{copy.attemptHitSource(view.hit)}</div>}
    </div>
  )
}
