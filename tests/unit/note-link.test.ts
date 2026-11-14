/**
 * 笔记链接解析用例
 *
 * 运行：node --test tests/unit/note-link.test.ts
 * 覆盖：合法链接（/explore/、/discovery/item/）与非法链接（无法解析出笔记 ID）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractNoteId, isValidNoteUrl } from '../../src/utils/automation/noteLink.ts'

describe('extractNoteId / isValidNoteUrl', () => {
  it('合法链接：/explore/ 路径能解析出笔记 ID', () => {
    const url = 'https://www.xiaohongshu.com/explore/65f1a2b3c4d5e6f7a8b9c0d1?xsec_token=abc'
    assert.equal(extractNoteId(url), '65f1a2b3c4d5e6f7a8b9c0d1')
    assert.equal(isValidNoteUrl(url), true)
  })

  it('合法链接：/discovery/item/ 路径能解析出笔记 ID', () => {
    const url = 'https://www.xiaohongshu.com/discovery/item/65f1a2b3c4d5e6f7a8b9c0d2?source=share'
    assert.equal(extractNoteId(url), '65f1a2b3c4d5e6f7a8b9c0d2')
    assert.equal(isValidNoteUrl(url), true)
  })

  it('合法链接：带首尾空格仍可解析（提交前应 trim）', () => {
    const url = '  https://www.xiaohongshu.com/explore/abc123XYZ  '
    assert.equal(extractNoteId(url), 'abc123XYZ')
    assert.equal(isValidNoteUrl(url), true)
  })

  it('非法链接：不含两种路径规则时解析为空 ID', () => {
    const url = 'https://www.xiaohongshu.com/user/profile/5f8a9b0c1d2e3f4a5b6c7d8e'
    assert.equal(extractNoteId(url), '')
    assert.equal(isValidNoteUrl(url), false)
  })

  it('非法链接：空字符串与纯空格解析为空 ID', () => {
    assert.equal(extractNoteId(''), '')
    assert.equal(extractNoteId('   '), '')
    assert.equal(isValidNoteUrl(''), false)
    assert.equal(isValidNoteUrl('   '), false)
  })

  it('非法链接：随机文本 / 域名首页解析为空 ID，不抛异常', () => {
    for (const bad of ['not a url', 'https://www.xiaohongshu.com/', 'explore', '/explore/']) {
      assert.equal(extractNoteId(bad), '', `应无法解析: ${bad}`)
      assert.equal(isValidNoteUrl(bad), false)
    }
  })

  it('非法链接：非字符串入参安全返回空 ID', () => {
    assert.equal(extractNoteId(undefined as unknown as string), '')
    assert.equal(extractNoteId(null as unknown as string), '')
    assert.equal(isValidNoteUrl(12345 as unknown as string), false)
  })

  it('防御：两种路径同时出现时优先匹配 /explore/', () => {
    const url = 'https://x.com/explore/aaa/discovery/item/bbb'
    assert.equal(extractNoteId(url), 'aaa')
  })
})
