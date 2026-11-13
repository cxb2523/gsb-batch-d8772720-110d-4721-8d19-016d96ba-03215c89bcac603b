import { afterEach, describe, expect, it, vi } from "vitest"
import { parseHtml, parseWeb } from "../web"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const htmlResponse = (html: string): Response =>
  new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })

const stubFetch = (impl: (url: string) => Response) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => impl(typeof input === "string" ? input : input.toString())),
  )
}

describe("parseHtml", () => {
  it("extracts title and produces markdown", async () => {
    const html = `<!doctype html>
      <html lang="en">
        <head><title>My Article</title></head>
        <body><article>
          <h1>My Article</h1>
          <p>${"Body sentence. ".repeat(40)}</p>
        </article></body>
      </html>`
    const result = await parseHtml(html, { url: "https://example.com/a" })
    expect(result.type).toBe("webpage")
    expect(result.title).toBe("My Article")
    expect(result.content).toContain("Body sentence.")
    expect(result.wordCount).toBeGreaterThan(50)
    expect(result.readTime).toMatch(/\d+ min/)
  })

  it("honours custom wordsPerMinute", async () => {
    const html = `<html><body><article><h1>t</h1>${"<p>" + "word ".repeat(100) + "</p>"}</article></body></html>`
    const fast = await parseHtml(html, { url: "https://example.com/", wordsPerMinute: 50 })
    const slow = await parseHtml(html, { url: "https://example.com/", wordsPerMinute: 500 })
    expect(parseInt(fast.readTime, 10)).toBeGreaterThan(parseInt(slow.readTime, 10))
  })

  it("accepts html without url", async () => {
    const html = "<html><body><article><h1>A</h1><p>Prose prose prose.</p></article></body></html>"
    const result = await parseHtml(html)
    expect(result.type).toBe("webpage")
    expect(result.domain).toBe("")
  })
})

describe("parseWeb", () => {
  it("resolves relative links against the final response URL after a redirect", async () => {
    const response = htmlResponse(
      '<article><p>Read the <a href="next.html">next page</a> for more details.</p></article>',
    )
    Object.defineProperty(response, "url", { value: "https://docs.example/guide/" })
    stubFetch(() => response)
    const result = await parseWeb("https://old.example/start", { allowPrivateNetworks: true })
    expect(result.content).toContain("https://docs.example/guide/next.html")
    expect(result.domain).toBe("docs.example")
  })
  it("fetches, parses HTML, and returns WebpageResult", async () => {
    stubFetch(() =>
      htmlResponse(
        `<html><head><title>Remote</title></head><body><article><h1>Remote</h1><p>${"Paragraph body. ".repeat(30)}</p></article></body></html>`,
      ),
    )
    const result = await parseWeb("https://public.example/a")
    expect(result.type).toBe("webpage")
    expect(result.title).toBe("Remote")
  })

  it("wraps raw-text content types in fenced code", async () => {
    stubFetch(
      () =>
        new Response(`{"hello":"world"}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    const result = await parseWeb("https://public.example/data.json")
    expect(result.type).toBe("webpage")
    expect(result.content).toContain("```json")
    expect(result.content).toContain('{"hello":"world"}')
  })

  it("rejects unsupported content types", async () => {
    stubFetch(() => new Response("zzz", { status: 200, headers: { "content-type": "audio/mpeg" } }))
    await expect(parseWeb("https://public.example/audio.mp3")).rejects.toThrow(/Unsupported content type/)
  })

  it("throws for non-ok responses", async () => {
    stubFetch(() => new Response("oops", { status: 500 }))
    await expect(parseWeb("https://public.example/x")).rejects.toThrow(/Failed to fetch: 500/)
  })

  it("refuses to fetch private networks by default", async () => {
    await expect(parseWeb("http://127.0.0.1/")).rejects.toThrow(/private/i)
  })

  it("allows private networks when opted in", async () => {
    stubFetch(() => htmlResponse("<html><body><article><h1>Local</h1><p>Body.</p></article></body></html>"))
    const result = await parseWeb("http://127.0.0.1/", { allowPrivateNetworks: true })
    expect(result.type).toBe("webpage")
  })

  it("refuses https -> http downgrade via redirect", async () => {
    let step = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (step++ === 0)
          return new Response("", { status: 301, headers: { location: "http://public.example/downgraded" } })
        return htmlResponse("<html><body><p>should never reach</p></body></html>")
      }),
    )
    await expect(parseWeb("https://public.example/")).rejects.toThrow(/https -> http/)
  })

  it("throws descriptive error on 3xx without Location", async () => {
    stubFetch(() => new Response("", { status: 302 }))
    await expect(parseWeb("https://public.example/")).rejects.toThrow(/Redirect \(302\)/)
  })

  it("rejects .pdf urls even when the server lies about the content type", async () => {
    stubFetch(() => new Response("%PDF-1.7 binary...", { status: 200, headers: { "content-type": "text/plain" } }))
    await expect(parseWeb("https://public.example/paper.pdf")).rejects.toThrow(/PDF parsing is not supported/)
  })

  it("preserves the TimeoutError name for programmatic consumers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out", "TimeoutError")
      }),
    )
    const failure = await parseWeb("https://public.example/slow", { timeoutMs: 1234 }).then(
      () => null,
      (err: unknown) => err as Error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure!.name).toBe("TimeoutError")
    expect(failure!.message).toContain("Timed out after 1234ms")
    expect(failure!.message).not.toContain("--timeout")
  })
})

describe("redirect records", () => {
  it("records a followed 302 with source, target and status, plus the final URL", async () => {
    const final = htmlResponse(
      '<html><body><article><h1>Landed</h1><p>Body text here.</p></article></body></html>',
    )
    Object.defineProperty(final, "url", { value: "https://docs.example/guide" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url === "https://old.example/start")
          return new Response("", { status: 302, headers: { location: "https://docs.example/guide" } })
        return final
      }),
    )
    const result = await parseWeb("https://old.example/start")
    expect(result.redirects).toEqual([
      { from: "https://old.example/start", to: "https://docs.example/guide", status: 302 },
    ])
    expect(result.finalUrl).toBe("https://docs.example/guide")
  })

  it("records multiple hops in order", async () => {
    const final = htmlResponse("<html><body><article><h1>End</h1><p>Text.</p></article></body></html>")
    Object.defineProperty(final, "url", { value: "https://c.example/end" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url === "https://a.example/1")
          return new Response("", { status: 301, headers: { location: "https://b.example/2" } })
        if (url === "https://b.example/2")
          return new Response("", { status: 302, headers: { location: "/end" } })
        return final
      }),
    )
    const result = await parseWeb("https://a.example/1")
    expect(result.redirects).toEqual([
      { from: "https://a.example/1", to: "https://b.example/2", status: 301 },
      { from: "https://b.example/2", to: "https://b.example/end", status: 302 },
    ])
    expect(result.finalUrl).toBe("https://c.example/end")
  })

  it("records an empty chain and the request URL when no redirect occurs", async () => {
    stubFetch(() => htmlResponse("<html><body><article><h1>Direct</h1><p>Text.</p></article></body></html>"))
    const result = await parseWeb("https://public.example/direct")
    expect(result.redirects).toEqual([])
    expect(result.finalUrl).toBe("https://public.example/direct")
  })

  it("still refuses https -> http downgrades and returns no result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 302, headers: { location: "http://public.example/plain" } })),
    )
    await expect(parseWeb("https://public.example/secure")).rejects.toThrow(/https -> http/)
  })

  it("reports only the successful attempt's chain after a simple-UA fallback", async () => {
    const final = htmlResponse("<html><body><article><h1>Fallback</h1><p>Text.</p></article></body></html>")
    Object.defineProperty(final, "url", { value: "https://public.example/c" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        const ua = new Headers(init?.headers).get("user-agent") ?? ""
        if (ua.includes("Mozilla")) {
          // Browser-UA attempt: one redirect, then UA-gated 403.
          if (url === "https://public.example/a")
            return new Response("", { status: 302, headers: { location: "https://public.example/b" } })
          return new Response("gated", { status: 403 })
        }
        // Simple-UA attempt: a different chain that succeeds.
        if (url === "https://public.example/a")
          return new Response("", { status: 301, headers: { location: "https://public.example/c" } })
        return final
      }),
    )
    const result = await parseWeb("https://public.example/a")
    expect(result.redirects).toEqual([
      { from: "https://public.example/a", to: "https://public.example/c", status: 301 },
    ])
    expect(result.finalUrl).toBe("https://public.example/c")
  })

  it("parseHtml reports an empty chain and the given url as final", async () => {
    const html = "<html><body><article><h1>A</h1><p>Prose prose prose.</p></article></body></html>"
    const withUrl = await parseHtml(html, { url: "https://example.com/a" })
    expect(withUrl.redirects).toEqual([])
    expect(withUrl.finalUrl).toBe("https://example.com/a")
    const withoutUrl = await parseHtml(html)
    expect(withoutUrl.redirects).toEqual([])
    expect(withoutUrl.finalUrl).toBe("")
  })
})
