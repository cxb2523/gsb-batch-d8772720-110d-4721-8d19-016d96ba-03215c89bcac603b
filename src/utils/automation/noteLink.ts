/**
 * 笔记链接解析工具
 *
 * 小红书笔记链接存在两种常见路径：
 * - /explore/<noteId>
 * - /discovery/item/<noteId>
 *
 * 采集任务提交前必须能从链接中解析出笔记 ID，否则后端会收到空 note_id，
 * 建出注定失败的任务。解析规则集中在此处，供表单校验与单元测试共用。
 *
 * @module utils/automation/noteLink
 */

/**
 * 从笔记链接中解析笔记 ID
 *
 * 沿用既有的 /explore/ 与 /discovery/item/ 两种路径规则，
 * 解析不到时返回空字符串（绝不抛出异常）。
 *
 * @param rawUrl 用户输入的笔记链接
 * @returns 笔记 ID；无法解析时返回 ''
 */
export function extractNoteId(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') {
    return ''
  }
  const url = rawUrl.trim()
  if (!url) {
    return ''
  }
  try {
    const match =
      url.match(/\/explore\/([a-zA-Z0-9]+)/) || url.match(/\/discovery\/item\/([a-zA-Z0-9]+)/)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

/**
 * 判断笔记链接是否能解析出有效的笔记 ID
 *
 * @param rawUrl 用户输入的笔记链接
 */
export function isValidNoteUrl(rawUrl: unknown): boolean {
  return extractNoteId(rawUrl) !== ''
}
