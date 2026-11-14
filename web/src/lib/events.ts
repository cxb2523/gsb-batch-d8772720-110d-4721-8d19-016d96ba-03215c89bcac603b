import { createParser, type EventSourceMessage } from 'eventsource-parser'

/**
 * Server events over fetch streaming (EventSource cannot send the Authorization header,
 * and a token in the URL would end up in logs and history). Events only say *what
 * changed*; the caller refetches over REST. On reconnect there is no Last-Event-ID: the
 * caller just reloads everything.
 */
export interface StreamOptions {
  token: string
  onEvent: (type: string, data: unknown) => void
  onOpen?: () => void
  signal: AbortSignal
  fetchImpl?: typeof fetch
  retryDelays?: number[]
}

export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (m: EventSourceMessage) => void,
): Promise<void> {
  const parser = createParser({ onEvent: onMessage })
  // stream: true keeps a multi-byte character split across chunks intact.
  const decoder = new TextDecoder()
  const reader = body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      parser.feed(decoder.decode())
      return
    }
    parser.feed(decoder.decode(value, { stream: true }))
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

export async function connectEvents({
  token,
  onEvent,
  onOpen,
  signal,
  fetchImpl = fetch,
  retryDelays = [1000, 2000, 5000, 10000, 30000],
}: StreamOptions): Promise<void> {
  let attempt = 0
  while (!signal.aborted) {
    try {
      const res = await fetchImpl('/api/events', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        credentials: 'omit',
        signal,
      })
      if (res.status === 401) return // session gone: the app shows "locked"
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      attempt = 0
      onOpen?.()
      await readEventStream(res.body, (m) => {
        let data: unknown = null
        try {
          data = JSON.parse(m.data)
        } catch {
          data = m.data
        }
        onEvent(m.event ?? 'message', data)
      })
    } catch {
      if (signal.aborted) return
    }
    await sleep(retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 30000, signal)
    attempt += 1
  }
}
