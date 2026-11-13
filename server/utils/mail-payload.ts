import type { Mail, MailFrom } from '~/types'

type MailParseResult = { ok: true, mail: Mail } | { ok: false, error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

/**
 * Validate one entry returned by an external mail source and normalize it
 * into the shape used by the inbox.
 */
export function parseIncomingMail(value: unknown): MailParseResult {
  if (!isRecord(value)) {
    return { ok: false, error: '邮件不是对象' }
  }

  const id = normalizeId(value.id)
  if (id === null) {
    return { ok: false, error: '缺少有效的 id' }
  }

  if (!isRecord(value.from) || typeof value.from.name !== 'string' || typeof value.from.email !== 'string') {
    return { ok: false, error: '缺少有效的 from（需包含 name 与 email）' }
  }

  if (typeof value.subject !== 'string') {
    return { ok: false, error: '缺少有效的 subject' }
  }

  if (typeof value.body !== 'string') {
    return { ok: false, error: '缺少有效的 body' }
  }

  if (typeof value.date !== 'string' || Number.isNaN(new Date(value.date).getTime())) {
    return { ok: false, error: '缺少有效的 date' }
  }

  if (value.unread !== undefined && typeof value.unread !== 'boolean') {
    return { ok: false, error: 'unread 必须为布尔值' }
  }

  const from: MailFrom = {
    name: value.from.name,
    email: value.from.email
  }

  if (isRecord(value.from.avatar) && typeof value.from.avatar.src === 'string') {
    from.avatar = { src: value.from.avatar.src }
  }

  const mail: Mail = {
    id,
    from,
    subject: value.subject,
    body: value.body,
    date: value.date
  }

  if (typeof value.unread === 'boolean') {
    mail.unread = value.unread
  }

  return { ok: true, mail }
}
