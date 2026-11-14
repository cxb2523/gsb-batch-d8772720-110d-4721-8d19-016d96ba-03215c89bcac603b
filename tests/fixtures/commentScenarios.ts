/**
 * 评论采集链路可复现样例数据
 *
 * 覆盖验收要求的四种情形：
 * 1. 合法链接（/explore/ 与 /discovery/item/ 各一条）
 * 2. 非法链接（解析不出笔记 ID）
 * 3. 失败但有数据（failed，current_count > 0，仍可查看结果）
 * 4. 失败且无数据（failed，current_count = 0，隐藏查看入口）
 *
 * 该文件同时被 tests/unit/fixture-scenarios.test.ts 引用做回归断言，
 * 也可在联调时作为任务列表 / 表单的手工构造数据。
 *
 * @module tests/fixtures/commentScenarios
 */
import type { Task } from '../../src/api/automation/task.ts'

/** 链接解析样例 */
export const noteUrlSamples = {
  validExplore: 'https://www.xiaohongshu.com/explore/65f1a2b3c4d5e6f7a8b9c0d1?xsec_token=tok',
  validDiscovery:
    'https://www.xiaohongshu.com/discovery/item/65f1a2b3c4d5e6f7a8b9c0d2?source=share',
  invalidProfile: 'https://www.xiaohongshu.com/user/profile/5f8a9b0c1d2e3f4a5b6c7d8e',
  invalidPlainText: 'not-a-valid-note-link',
  empty: ''
} as const

/** 期望解析出的笔记 ID（非法链接期望为空串） */
export const expectedNoteIds: Record<keyof typeof noteUrlSamples, string> = {
  validExplore: '65f1a2b3c4d5e6f7a8b9c0d1',
  validDiscovery: '65f1a2b3c4d5e6f7a8b9c0d2',
  invalidProfile: '',
  invalidPlainText: '',
  empty: ''
}

/** 任务行样例：失败但有数据 */
export const failedWithDataTask: Task = {
  task_id: 'failed-with-data-0001',
  type: 'collect_comments',
  status: 'failed',
  target_count: 100,
  current_count: 37,
  message: '连续失败次数达到上限 (3)',
  created_at: '2026-11-14T10:00:00Z',
  updated_at: '2026-11-14T10:05:00Z',
  params: { note_id: '65f1a2b3c4d5e6f7a8b9c0d1', max_count: 100 }
}

/** 任务行样例：失败且无数据 */
export const failedWithoutDataTask: Task = {
  task_id: 'failed-no-data-0002',
  type: 'collect_comments',
  status: 'failed',
  target_count: 100,
  current_count: 0,
  message: '笔记不存在或已删除',
  created_at: '2026-11-14T11:00:00Z',
  updated_at: '2026-11-14T11:01:00Z',
  params: { note_id: 'deadbeefdeadbeefdeadbeef', max_count: 100 }
}

/** 任务行样例：中途停止、有数据、message 为空（验证固定文案兜底） */
export const stoppedWithDataNoMessageTask: Task = {
  task_id: 'stopped-no-msg-0003',
  type: 'collect_comments',
  status: 'stopped',
  target_count: 0,
  current_count: 12,
  message: '',
  created_at: '2026-11-14T12:00:00Z',
  updated_at: '2026-11-14T12:10:00Z',
  params: { note_id: '65f1a2b3c4d5e6f7a8b9c0d3', max_count: 100 }
}

/** 任务行样例：正常完成、有数据（对照组） */
export const completedTask: Task = {
  task_id: 'completed-0004',
  type: 'collect_comments',
  status: 'completed',
  target_count: 50,
  current_count: 50,
  message: '',
  created_at: '2026-11-14T13:00:00Z',
  updated_at: '2026-11-14T13:20:00Z',
  params: { note_id: '65f1a2b3c4d5e6f7a8b9c0d4', max_count: 50 }
}

/** 任务行样例集合，可整体灌入任务列表组件做手工联调 */
export const sampleTasks: Task[] = [
  failedWithDataTask,
  failedWithoutDataTask,
  stoppedWithDataNoMessageTask,
  completedTask
]
