/**
 * 四种验收情形的端到端断言（纯逻辑层，无需浏览器）
 *
 * 运行：node --test tests/unit/fixture-scenarios.test.ts
 * 数据来源：tests/fixtures/commentScenarios.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractNoteId, isValidNoteUrl } from '../../src/utils/automation/noteLink.ts'
import {
  buildCommentTaskRow,
  shouldShowViewButton
} from '../../src/utils/automation/taskOutcome.ts'
import {
  completedTask,
  expectedNoteIds,
  failedWithoutDataTask,
  failedWithDataTask,
  noteUrlSamples,
  sampleTasks,
  stoppedWithDataNoMessageTask
} from '../fixtures/commentScenarios.ts'

describe('情形一：合法链接可解析出笔记 ID', () => {
  it('/explore/ 与 /discovery/item/ 均合法', () => {
    for (const key of ['validExplore', 'validDiscovery'] as const) {
      assert.equal(extractNoteId(noteUrlSamples[key]), expectedNoteIds[key])
      assert.equal(isValidNoteUrl(noteUrlSamples[key]), true)
      assert.notEqual(expectedNoteIds[key], '')
    }
  })
})

describe('情形二：非法链接被拦截', () => {
  it('个人主页 / 纯文本 / 空串均解析为空 ID 且判定非法', () => {
    for (const key of ['invalidProfile', 'invalidPlainText', 'empty'] as const) {
      assert.equal(extractNoteId(noteUrlSamples[key]), '')
      assert.equal(expectedNoteIds[key], '')
      assert.equal(isValidNoteUrl(noteUrlSamples[key]), false)
    }
  })
})

describe('情形三：失败但有数据', () => {
  const row = buildCommentTaskRow(failedWithDataTask)

  it('展示停止原因与已采数（37 条）', () => {
    assert.equal(row.isEndedWithProblem, true)
    assert.equal(row.collectedCount, 37)
    assert.equal(row.stopReason, '连续失败次数达到上限 (3)')
  })

  it('“查看结果”按钮必须出现，点击可走 TaskResultDrawer 分页拉取', () => {
    assert.equal(row.canViewResults, true)
    assert.equal(shouldShowViewButton(failedWithDataTask), true)
  })
})

describe('情形四：失败且无数据', () => {
  const row = buildCommentTaskRow(failedWithoutDataTask)

  it('仍展示停止原因，但已采数为 0', () => {
    assert.equal(row.isEndedWithProblem, true)
    assert.equal(row.collectedCount, 0)
    assert.equal(row.stopReason, '笔记不存在或已删除')
  })

  it('“查看结果”按钮隐藏', () => {
    assert.equal(row.canViewResults, false)
    assert.equal(shouldShowViewButton(failedWithoutDataTask), false)
  })
})

describe('补充：停止无 message 的固定文案与对照组', () => {
  it('stopped + 空 message 使用固定文案，已采 12 条仍可查看', () => {
    const row = buildCommentTaskRow(stoppedWithDataNoMessageTask, '任务已停止，未提供具体原因')
    assert.equal(row.stopReason, '任务已停止，未提供具体原因')
    assert.equal(row.collectedCount, 12)
    assert.equal(row.canViewResults, true)
  })

  it('completed 对照组不显示问题结局，有数据可查看', () => {
    const row = buildCommentTaskRow(completedTask)
    assert.equal(row.isEndedWithProblem, false)
    assert.equal(row.stopReason, '')
    assert.equal(row.canViewResults, true)
  })

  it('样例集合共 4 行，可整体灌入任务列表联调', () => {
    assert.equal(sampleTasks.length, 4)
  })
})
