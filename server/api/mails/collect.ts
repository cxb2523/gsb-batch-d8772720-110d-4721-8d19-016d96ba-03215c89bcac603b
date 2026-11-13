import type { Mail, MailCollectResult, MailSource } from '~/types'
import { mergeCollectedMails } from '../../utils/mail-store'
import { parseIncomingMail } from '../../utils/mail-payload'

const FETCH_TIMEOUT = 8000

function failResult(url: string, label: string | undefined, error: string): MailCollectResult {
  return { url, ...(label ? { label } : {}), status: 'error', fetched: 0, error }
}

function okResult(url: string, label: string | undefined, fetched: number): MailCollectResult {
  return { url, ...(label ? { label } : {}), status: 'ok', fetched }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeSource(raw: unknown): MailSource | null {
  if (!isRecord(raw) || typeof raw.url !== 'string' || raw.url.trim() === '') {
    return null
  }

  const source: MailSource = { url: raw.url.trim() }
  if (typeof raw.label === 'string' && raw.label.trim() !== '') {
    source.label = raw.label.trim()
  }

  return source
}

/** Turn an unknown thrown value into a short, user-facing reason. */
function describeError(error: unknown): string {
  // ofetch wraps the real cause: a timeout surfaces as FetchError -> TimeoutError.
  const chain: unknown[] = []
  let current: unknown = error
  while (current && chain.length < 5) {
    chain.push(current)
    current = isRecord(current) ? current.cause : undefined
  }

  if (chain.some(item => isRecord(item) && item.name === 'TimeoutError')) {
    return `请求超时（超过 ${FETCH_TIMEOUT}ms 未响应）`
  }

  if (chain.some(item => isRecord(item) && item.name === 'AbortError')) {
    return '请求被中止'
  }

  if (error instanceof Error) {
    const message = error.message.trim()
    return message || error.name || '未知错误'
  }

  return String(error) || '未知错误'
}

/**
 * Fetch one source and merge its mails into the inbox.
 * Any problem with this source (network, timeout, bad payload) only marks this
 * one source as failed; the caller keeps processing the remaining sources.
 */
async function collectSource(source: MailSource): Promise<MailCollectResult> {
  const { url, label } = source

  let payload: unknown
  try {
    payload = await $fetch(url, { timeout: FETCH_TIMEOUT, retry: 0 })
  } catch (error) {
    return failResult(url, label, describeError(error))
  }

  if (!Array.isArray(payload)) {
    return failResult(url, label, '返回内容不是邮件数组')
  }

  const mails: Mail[] = []
  for (let index = 0; index < payload.length; index++) {
    const parsed = parseIncomingMail(payload[index])
    if (!parsed.ok) {
      return failResult(url, label, `第 ${index + 1} 封邮件字段缺失或不合法：${parsed.error}`)
    }
    mails.push(parsed.mail)
  }

  const fetched = mergeCollectedMails(url, mails)
  return okResult(url, label, fetched)
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => undefined)
  const rawSources = isRecord(body) && Array.isArray(body.sources)
    ? body.sources
    : Array.isArray(body)
      ? body
      : undefined

  if (!rawSources) {
    throw createError({
      statusCode: 400,
      statusMessage: '请求体需包含 sources 数组'
    })
  }

  // Sources are fetched one by one so a slow or failing source cannot affect
  // the others; every source always produces exactly one result entry.
  const results: MailCollectResult[] = []
  for (const raw of rawSources) {
    const source = normalizeSource(raw)
    if (!source) {
      results.push({
        url: isRecord(raw) && typeof raw.url === 'string' ? raw.url : '',
        status: 'error',
        fetched: 0,
        error: '来源格式无效，需包含 url 字段'
      })
      continue
    }

    results.push(await collectSource(source))
  }

  return { results }
})
