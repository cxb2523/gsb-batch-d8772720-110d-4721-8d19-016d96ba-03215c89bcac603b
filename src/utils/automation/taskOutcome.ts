/**
 * 采集任务结局呈现工具
 *
 * 任务列表对失败 / 中途停止的采集任务，需要回答两个问题：
 * 1. 为什么停了 —— 取任务 message，为空时给固定文案；
 * 2. 已采了多少 —— current_count，大于 0 时即使任务失败也允许查看结果。
 *
 * 判定逻辑集中在此处，供任务列表与单元测试共用，保证
 * collect_comments 与 collect_notes 的“查看结果”按钮口径一致。
 *
 * @module utils/automation/taskOutcome
 */

/** 任务行的最小结构（与 API 的 Task 类型兼容） */
export interface TaskLike {
  type: string
  status: string
  current_count?: number
  target_count?: number
  message?: string
}

/** 带可读结局的采集任务行视图模型 */
export interface CommentTaskRowModel {
  /** 已采评论数（缺省按 0 处理） */
  collectedCount: number
  /** 是否为失败或中途停止的结局 */
  isEndedWithProblem: boolean
  /** 停止原因：优先取 message，为空时使用固定文案 */
  stopReason: string
  /** 是否展示“查看结果”按钮：已采数大于 0 即展示，与任务结局无关 */
  canViewResults: boolean
}

/** 失败 / 停止状态集合 */
export const PROBLEM_STATUSES = ['failed', 'stopped'] as const

/** message 为空时的固定停止原因文案（中文兜底，界面层可传入 i18n 文案覆盖） */
export const DEFAULT_STOP_REASON = '任务已停止，未提供具体原因'

/**
 * 解析任务停止原因
 *
 * @param task 任务行
 * @param fallback message 为空时使用的固定文案
 */
export function resolveStopReason(
  task: Pick<TaskLike, 'status' | 'message'>,
  fallback = DEFAULT_STOP_REASON
): string {
  const message = typeof task.message === 'string' ? task.message.trim() : ''
  return message || fallback
}

/**
 * 读取已采数量，缺失或非法时按 0 处理
 */
export function getCollectedCount(task: Pick<TaskLike, 'current_count'>): number {
  const count = Number(task.current_count)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

/**
 * 任务结局是否为失败 / 中途停止
 */
export function isProblemStatus(status: string): boolean {
  return (PROBLEM_STATUSES as readonly string[]).includes(status)
}

/**
 * 是否展示“查看结果”按钮
 *
 * 采集类任务（collect_notes / collect_comments）统一按已采数判定：
 * 已采数 > 0 即可查看，即使任务已失败或停止；为 0 时隐藏。
 * browse_agent 任务始终可查看（日志/详情）。
 */
export function shouldShowViewButton(task: TaskLike): boolean {
  if (['collect_notes', 'collect_comments'].includes(task.type)) {
    return getCollectedCount(task) > 0
  }
  return task.type === 'browse_agent'
}

/**
 * 构造 collect_comments 任务行的可读结局视图模型
 *
 * @param task 任务行
 * @param fallbackStopReason message 为空时的固定文案
 */
export function buildCommentTaskRow(
  task: TaskLike,
  fallbackStopReason = DEFAULT_STOP_REASON
): CommentTaskRowModel {
  const collectedCount = getCollectedCount(task)
  const isEndedWithProblem = isProblemStatus(task.status)
  return {
    collectedCount,
    isEndedWithProblem,
    stopReason: isEndedWithProblem ? resolveStopReason(task, fallbackStopReason) : '',
    canViewResults: shouldShowViewButton(task)
  }
}
