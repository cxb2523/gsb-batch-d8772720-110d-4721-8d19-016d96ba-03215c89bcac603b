import { connectEvents, readEventStream } from './events'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

describe('readEventStream', () => {
  it('parses events split across chunks, ignoring keepalive comments', async () => {
    const got: { event?: string; data: string }[] = []
    await readEventStream(
      streamOf([
        ': connected\n\n',
        'event: check_pro',
        'gress\ndata: {"done":1,',
        '"total":2}\n',
        '\n: keepalive\n\n',
        'event: check_all_done\ndata: {}\n\n',
      ]),
      (m) => got.push({ event: m.event, data: m.data }),
    )
    expect(got).toEqual([
      { event: 'check_progress', data: '{"done":1,"total":2}' },
      { event: 'check_all_done', data: '{}' },
    ])
  })

  it('keeps a multi-byte character split between chunks', async () => {
    const bytes = new TextEncoder().encode('event: x\ndata: "año"\n\n')
    const cut = bytes.indexOf(0xc3) + 1 // inside "ñ"
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut))
        c.enqueue(bytes.slice(cut))
        c.close()
      },
    })
    const got: string[] = []
    await readEventStream(stream, (m) => got.push(m.data))
    expect(got).toEqual(['"año"'])
  })
})

describe('connectEvents', () => {
  it('sends the token in a header, not the URL, and stops on abort', async () => {
    const controller = new AbortController()
    const calls: [string, RequestInit][] = []
    const events: string[] = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init])
      controller.abort()
      return new Response(streamOf(['event: credentials_changed\ndata: {"id":"x"}\n\n']), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await connectEvents({
      token: 'tok',
      signal: controller.signal,
      fetchImpl,
      onEvent: (type) => events.push(type),
    })
    expect(calls[0]?.[0]).toBe('/api/events')
    expect(new Headers(calls[0]?.[1].headers).get('Authorization')).toBe('Bearer tok')
    expect(events).toEqual(['credentials_changed'])
  })

  it('gives up on 401 (session gone)', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 401 }),
    ) as unknown as typeof fetch
    await connectEvents({ token: 't', signal: controller.signal, fetchImpl, onEvent: () => {} })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
