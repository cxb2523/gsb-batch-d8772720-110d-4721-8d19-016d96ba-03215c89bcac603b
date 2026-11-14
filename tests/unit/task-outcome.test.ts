/**
 * 任务行结局呈现用例
 *
 * 运行：node --test tests/unit/task-outcome.test.ts
 * 覆盖：
 *  - 失败但有数据（current_count > 0）：展示停止原因 + 已采数 + “查看结果”按钮
 *  - 失败且无数据（current_count = 0）：展示停止原因，按钮隐藏
 *  - 中途停止（stopped）的有数据 / 无数据分支
 *  - 正常运行 / 完成任务不受影响
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCommentTaskRow,
  getCollectedCount,
  isProblemStatus,
  resolveStopReason,
  shouldShowViewButton,
  DEFAULT_STOP_REASON,
  type TaskLike
} from '../../src/utils/automation/taskOutcome.ts'

const baseTask = (overrides: Partial<TaskLike>): TaskLike =>
  ({
    task_id: 't-1',
    type: 'collect_comments',
    status: 'running',
    current_count: 0,
    target_count: 100,
    message: '',
    ...overrides
  }) as TaskLike

describe('失败但有数据', () => {
  const row = buildCommentTaskRow(
    baseTask({
      status: 'failed',
      current_count: 37,
      target_count: 100,
      message: '连续失败次数达到上限 (3)'
    })
  )

  it('暴露已采评论数', () => {
    assert.equal(row.collectedCount, 37)
    assert.equal(getCollectedCount({ current_count: 37 }), 37)
  })

  it('标记为问题结局并透出后端停止原因', () => {
    assert.equal(row.isEndedWithProblem, true)
    assert.equal(row.stopReason, '连续失败次数达到上限 (3)')
    assert.equal(isProblemStatus('failed'), true)
  })

  it('已采数 > 0 时“查看结果”按钮必须出现，即使任务失败', () => {
    assert.equal(row.canViewResults, true)
    assert.equal(
      shouldShowViewButton(
        baseTask({ type: 'collect_comments', status: 'failed', current_count: 1 })
      ),
      true
    )
  })
})

describe('失败且无数据', () => {
  const row = buildCommentTaskRow(
    baseTask({ status: 'failed', current_count: 0, message: '笔记不存在或已删除' })
  )

  it('已采数为 0', () => {
    assert.equal(row.collectedCount, 0)
  })

  it('透出停止原因', () => {
    assert.equal(row.isEndedWithProblem, true)
    assert.equal(row.stopReason, '笔记不存在或已删除')
  })

  it('已采数为 0 时按钮隐藏，与 collect_notes 口径一致', () => {
    assert.equal(row.canViewResults, false)
    assert.equal(
      shouldShowViewButton(
        baseTask({ type: 'collect_comments', status: 'failed', current_count: 0 })
      ),
      false
    )
    assert.equal(
      shouldShowViewButton(baseTask({ type: 'collect_notes', status: 'failed', current_count: 0 })),
      false
    )
    assert.equal(
      shouldShowViewButton(baseTask({ type: 'collect_notes', status: 'failed', current_count: 5 })),
      true
    )
  })

  it('current_count 缺失 / 非法时按 0 处理', () => {
    assert.equal(getCollectedCount({}), 0)
    assert.equal(getCollectedCount({ current_count: undefined }), 0)
    assert.equal(getCollectedCount({ current_count: NaN as unknown as number }), 0)
    assert.equal(
      shouldShowViewButton(baseTask({ type: 'collect_comments', status: 'failed' })),
      false
    )
  })
})

describe('中途停止 stopped', () => {
  it('stopped 且有数据：显示停止原因与已采数，按钮可见', () => {
    const row = buildCommentTaskRow(
      baseTask({ status: 'stopped', current_count: 12, message: '用户手动停止' })
    )
    assert.equal(row.isEndedWithProblem, true)
    assert.equal(row.collectedCount, 12)
    assert.equal(row.stopReason, '用户手动停止')
    assert.equal(row.canViewResults, true)
    assert.equal(isProblemStatus('stopped'), true)
  })

  it('stopped 且无数据、message 为空：使用固定文案，按钮隐藏', () => {
    const row = buildCommentTaskRow(baseTask({ status: 'stopped', current_count: 0 }))
    assert.equal(row.stopReason, DEFAULT_STOP_REASON)
    assert.equal(row.canViewResults, false)
    assert.equal(resolveStopReason({ status: 'stopped', message: '   ' }), DEFAULT_STOP_REASON)
  })

  it('固定文案可由界面层（i18n）覆盖', () => {
    const row = buildCommentTaskRow(
      baseTask({ status: 'stopped', current_count: 0, message: '' }),
      'The task stopped without a specific reason'
    )
    assert.equal(row.stopReason, 'The task stopped without a specific reason')
  })
})

describe('正常结局不受影响', () => {
  it('running / completed 不是问题结局，不生成停止原因', () => {
    for (const status of ['pending', 'running', 'completed']) {
      const row = buildCommentTaskRow(baseTask({ status, current_count: 5 }))
      assert.equal(row.isEndedWithProblem, false)
      assert.equal(row.stopReason, '')
    }
    assert.equal(isProblemStatus('running'), false)
    assert.equal(isProblemStatus('completed'), false)
  })

  it('completed 且有数据：按钮可见', () => {
    const row = buildCommentTaskRow(baseTask({ status: 'completed', current_count: 100 }))
    assert.equal(row.canViewResults, true)
  })

  it('browse_agent 始终可查看', () => {
    assert.equal(
      shouldShowViewButton(baseTask({ type: 'browse_agent', status: 'failed', current_count: 0 })),
      true
    )
  })
})
