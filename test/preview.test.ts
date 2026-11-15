import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkpeekError } from "../src/errors.js";
import { preview } from "../src/index.js";

const liveTestsEnabled = process.env.LINKPEEK_LIVE_TESTS === "1";

describe.skipIf(!liveTestsEnabled)("preview() live URLs", () => {
	it("fetches a live URL and returns metadata", {
		timeout: 15000,
	}, async () => {
		const result = await preview("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		expect(result.url).toBeTruthy();
		expect(result.title).toBeTruthy();
		expect(result.siteName).toBeTruthy();
		expect(result.image).toBeTruthy();
		expect(result.statusCode).toBe(200);
	});

	it("returns image field for a direct image URL", {
		timeout: 15000,
	}, async () => {
		const imageUrl =
			"https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";
		const result = await preview(imageUrl);
		expect(result.image).toBe(imageUrl);
		expect(result.title).toBeNull();
		expect(result.statusCode).toBe(200);
	});
});

describe("preview()", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("stops reading the response after the head in fast mode", async () => {
		const encoder = new TextEncoder();
		const page = encoder.encode(
			`<html><head><title>Early title</title></head><body>${"x".repeat(50_000)}</body></html>`,
		);
		let emittedBytes = 0;
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emittedBytes >= page.length) {
					controller.close();
					return;
				}
				const end = Math.min(emittedBytes + 512, page.length);
				controller.enqueue(page.slice(emittedBytes, end));
				emittedBytes = end;
			},
			cancel() {
				canceled = true;
			},
		});
		const fetchMock = vi.fn(
			async () =>
				new Response(body, {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);

		const result = await preview("https://example.com/article", {
			fetch: fetchMock,
			maxBytes: 30_000,
		});

		expect(result.title).toBe("Early title");
		expect(canceled).toBe(true);
		expect(emittedBytes).toBeLessThan(30_000);
	});

	it.each([false, true])(
		"ignores nested template metadata and refreshes (body scan=%s)",
		async (includeBodyContent) => {
			const chunks = [
				'<head><template><meta property="og:title" content="Inert"><meta http-equiv="refresh" content="0; url=/wrong"><template><div>Inert body</div></template></template>',
				'<title>Real title</title></head><body><template><img src="/inert.jpg"><script type="application/ld+json">{"name":"Inert JSON"}</script></template><img src="/real.jpg"></body>',
			];
			const fetchMock = vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								const chunk = chunks.shift();
								if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
								else controller.close();
							},
						}),
						{ headers: { "content-type": "text/html" } },
					),
			);
			const result = await preview("https://example.com", {
				fetch: fetchMock,
				includeBodyContent,
				followMetaRefresh: true,
			});
			expect(result.title).toBe("Real title");
			expect(result.image).toBe(
				includeBodyContent ? "https://example.com/real.jpg" : null,
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("continues reading body metadata when body scanning is enabled", async () => {
		const page = `<html><head><title>Head fallback</title></head><body>
			${"padding ".repeat(300)}
			<script type="application/ld+json">
				{"headline":"Body JSON-LD title"}
			</script>
		</body></html>`;
		const fetchMock = vi.fn(
			async () =>
				new Response(page, {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);

		const result = await preview("https://example.com/article", {
			fetch: fetchMock,
			includeBodyContent: true,
			maxBytes: 10_000,
		});

		expect(result.title).toBe("Body JSON-LD title");
	});

	it("streams through a body image fallback when body scanning is enabled", async () => {
		const encoder = new TextEncoder();
		const page = encoder.encode(
			`<html><head><title>Body image</title></head><body>${"padding ".repeat(300)}<img src="/fallback.jpg"></body></html>`,
		);
		let emittedBytes = 0;
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emittedBytes >= page.length) {
					controller.close();
					return;
				}
				const end = Math.min(emittedBytes + 256, page.length);
				controller.enqueue(page.slice(emittedBytes, end));
				emittedBytes = end;
			},
			cancel() {
				canceled = true;
			},
		});
		const fetchMock = vi.fn(
			async () =>
				new Response(body, {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);

		const result = await preview("https://example.com/article", {
			fetch: fetchMock,
			includeBodyContent: true,
			maxBytes: 10_000,
		});

		expect(result.image).toBe("https://example.com/fallback.jpg");
		expect(emittedBytes).toBe(page.length);
		expect(canceled).toBe(false);
	});

	it("does not make body meta refresh behavior depend on response chunking", async () => {
		const head = "<html><head><title>Article</title></head><body>";
		const bodyRefresh =
			'<meta http-equiv="refresh" content="0; url=https://example.com/unexpected">';
		const encoder = new TextEncoder();
		const chunks = [encoder.encode(head), encoder.encode(bodyRefresh)];
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = chunks.shift();
				if (next) controller.enqueue(next);
				else controller.close();
			},
		});
		const fetchMock = vi.fn(
			async () =>
				new Response(body, {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);

		const result = await preview("https://example.com/article", {
			fetch: fetchMock,
			followMetaRefresh: true,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.title).toBe("Article");
	});

	it("throws on invalid URL", async () => {
		await expect(preview("not-a-valid-url")).rejects.toThrow();
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
		"rejects an invalid maxRedirects value (%s) before fetching",
		async (maxRedirects) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				preview("https://example.com", { maxRedirects }),
			).rejects.toMatchObject({
				code: "INVALID_OPTIONS",
			});
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2_147_483_648])(
		"rejects an invalid timeout value (%s) before fetching",
		async (timeout) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				preview("https://example.com", { timeout }),
			).rejects.toMatchObject({
				code: "INVALID_OPTIONS",
			});
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("detects direct media content types case-insensitively", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(null, {
						status: 200,
						headers: { "content-type": "Image/PNG" },
					}),
			),
		);

		const result = await preview("https://example.com/image.png");

		expect(result.image).toBe("https://example.com/image.png");
		expect(result.mediaType).toBe("image");
	});

	it("follows meta-refresh interstitials even when they have a title", async () => {
		const interstitial = `<html><head>
			<title>Just a moment...</title>
			<meta http-equiv="refresh" content="0; url=https://example.com/real">
		</head></html>`;
		const destination = `<html><head>
			<title>Real Title</title>
		</head></html>`;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(interstitial, {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(destination, {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await preview("https://example.com/start", {
			followMetaRefresh: true,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.title).toBe("Real Title");
		expect(result.url).toBe("https://example.com/real");
	});

	it.each([
		{
			httpRedirect: false,
			target: "https://other.example/real",
			expected: null,
		},
		{
			httpRedirect: true,
			target: "https://other.example/real",
			expected: null,
		},
		{
			httpRedirect: false,
			target: "https://example.com/real",
			expected: "site-value",
		},
	])(
		"keeps custom headers on the original origin across meta refresh ($httpRedirect, $target)",
		async ({ httpRedirect, target, expected }) => {
			const seen: (string | null)[] = [];
			const fetchMock = vi.fn(
				async (input: string | URL | Request, init?: RequestInit) => {
					seen.push(new Headers(init?.headers).get("X-Site-Header"));
					if (httpRedirect && seen.length === 1)
						return new Response(null, {
							status: 302,
							headers: { location: "https://other.example/interstitial" },
						});
					return new Response(
						String(input) === target
							? "<head><title>Destination</title></head>"
							: `<head><meta http-equiv="refresh" content="0; url=${target}"></head>`,
						{ headers: { "content-type": "text/html" } },
					);
				},
			);
			const result = await preview("https://example.com/start", {
				fetch: fetchMock,
				followMetaRefresh: true,
				headers: { "X-Site-Header": "site-value" },
			});
			expect(result.title).toBe("Destination");
			expect(seen[0]).toBe("site-value");
			expect(seen.slice(1)).toEqual(
				httpRedirect ? [null, expected] : [expected],
			);
		},
	);

	it("rethrows caller aborts during a meta-refresh request", async () => {
		const interstitial = `<html><head>
			<meta http-equiv="refresh" content="0; url=https://example.com/real">
		</head></html>`;
		const controller = new AbortController();
		const abortReason = new DOMException(
			"Caller stopped preview",
			"AbortError",
		);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(interstitial, {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			)
			.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
				controller.abort(abortReason);
				throw init?.signal?.reason;
			});
		vi.stubGlobal("fetch", fetchMock);

		const result = preview("https://example.com/start", {
			followMetaRefresh: true,
			signal: controller.signal,
		});

		await expect(result).rejects.toBe(abortReason);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not refetch slow meta refreshes", async () => {
		const page = `<html><head>
			<title>Liveblog</title>
			<meta http-equiv="refresh" content="60; url=https://example.com/reload">
		</head></html>`;
		const fetchMock = vi.fn(
			async () =>
				new Response(page, {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await preview("https://example.com/start", {
			followMetaRefresh: true,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.title).toBe("Liveblog");
	});

	it("returns the HTTP status code for non-2xx HTML responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("<html><head><title>Not Found</title></head></html>", {
						status: 404,
						headers: { "content-type": "text/html" },
					}),
			),
		);

		const result = await preview("https://example.com/missing");

		expect(result.statusCode).toBe(404);
		expect(result.title).toBe("Not Found");
	});
});

describe("preview() redirect trail", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("reports every same-origin HTTP redirect in order with the final URL", async () => {
		const pages: Record<string, string> = {
			"https://example.com/step-2": "<head><title>Final title</title></head>",
		};
		const locations: Record<string, string> = {
			"https://example.com/start": "https://example.com/step-1",
			"https://example.com/step-1": "https://example.com/step-2",
		};
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			const location = locations[url];
			if (location)
				return new Response(null, { status: 302, headers: { location } });
			return new Response(pages[url] ?? "<head></head>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		});

		const result = await preview("https://example.com/start", {
			fetch: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://example.com/step-1",
				type: "http",
				ok: true,
			},
			{
				from: "https://example.com/step-1",
				to: "https://example.com/step-2",
				type: "http",
				ok: true,
			},
		]);
		expect(result.url).toBe("https://example.com/step-2");
		expect(result.title).toBe("Final title");
	});

	it("drops custom headers on a cross-origin redirect and still records the hop", async () => {
		const seenHeaders: (string | null)[] = [];
		const fetchMock = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				seenHeaders.push(new Headers(init?.headers).get("X-Site-Header"));
				if (String(input) === "https://example.com/start")
					return new Response(null, {
						status: 301,
						headers: { location: "https://other.example/final" },
					});
				return new Response("<head><title>Other</title></head>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			},
		);

		const result = await preview("https://example.com/start", {
			fetch: fetchMock,
			headers: { "X-Site-Header": "site-value" },
		});

		expect(seenHeaders).toEqual(["site-value", null]);
		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://other.example/final",
				type: "http",
				ok: true,
			},
		]);
		expect(result.title).toBe("Other");
	});

	it("records the blocked private-network hop without requesting it", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "http://127.0.0.1/internal" },
				}),
		);

		const error = (await preview("https://example.com/start", {
			fetch: fetchMock,
		}).catch((caught: unknown) => caught)) as LinkpeekError;

		expect(error).toBeInstanceOf(LinkpeekError);
		expect(error.code).toBe("PRIVATE_NETWORK_BLOCKED");
		expect(error.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "http://127.0.0.1/internal",
				type: "http",
				ok: false,
				errorCode: "PRIVATE_NETWORK_BLOCKED",
			},
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the original page metadata when a meta refresh target stalls mid-body", async () => {
		vi.useFakeTimers();
		const interstitial = `<html><head>
			<title>Interstitial</title>
			<meta http-equiv="refresh" content="0; url=https://example.com/stalls">
		</head></html>`;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(interstitial, {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			)
			.mockImplementationOnce(
				(_input: string | URL | Request, init?: RequestInit) =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode(
										"<head><title>Never finishes</title>",
									),
								);
								init?.signal?.addEventListener(
									"abort",
									() => controller.error(init.signal?.reason),
									{ once: true },
								);
							},
							pull() {
								return new Promise<void>(() => {});
							},
						}),
						{ headers: { "content-type": "text/html; charset=utf-8" } },
					),
			);

		const pending = preview("https://example.com/start", {
			fetch: fetchMock,
			followMetaRefresh: true,
			timeout: 10,
		});
		await vi.advanceTimersByTimeAsync(10);
		const result = await pending;
		vi.useRealTimers();

		expect(result.title).toBe("Interstitial");
		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://example.com/stalls",
				type: "meta-refresh",
				ok: false,
				errorCode: "TIMEOUT",
			},
		]);
	});

	it("keeps the original page metadata when a meta refresh target times out", async () => {
		vi.useFakeTimers();
		const interstitial = `<html><head>
			<title>Interstitial</title>
			<meta http-equiv="refresh" content="0; url=https://example.com/slow">
		</head></html>`;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(interstitial, {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			)
			.mockImplementationOnce(
				(_input: string | URL | Request, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new DOMException("Aborted", "AbortError")),
							{ once: true },
						);
					}),
			);

		const pending = preview("https://example.com/start", {
			fetch: fetchMock,
			followMetaRefresh: true,
			timeout: 10,
		});
		await vi.advanceTimersByTimeAsync(10);
		const result = await pending;
		vi.useRealTimers();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.title).toBe("Interstitial");
		expect(result.url).toBe("https://example.com/start");
		expect(result.statusCode).toBe(200);
		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://example.com/slow",
				type: "meta-refresh",
				ok: false,
				errorCode: "TIMEOUT",
			},
		]);
	});

	it("records a followed meta refresh as a successful step", async () => {
		const interstitial = `<html><head>
			<meta http-equiv="refresh" content="0; url=https://example.com/real">
		</head></html>`;
		const fetchMock = vi.fn(
			async (input: string | URL | Request) =>
				new Response(
					String(input) === "https://example.com/real"
						? "<head><title>Real</title></head>"
						: interstitial,
					{ status: 200, headers: { "content-type": "text/html" } },
				),
		);

		const result = await preview("https://example.com/start", {
			fetch: fetchMock,
			followMetaRefresh: true,
		});

		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://example.com/real",
				type: "meta-refresh",
				ok: true,
			},
		]);
		expect(result.url).toBe("https://example.com/real");
	});

	it("combines HTTP redirects and a meta refresh into one ordered trail", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === "https://example.com/start")
				return new Response(null, {
					status: 302,
					headers: { location: "https://example.com/interstitial" },
				});
			if (url === "https://example.com/interstitial")
				return new Response(
					`<head><meta http-equiv="refresh" content="0; url=https://example.com/final"></head>`,
					{ status: 200, headers: { "content-type": "text/html" } },
				);
			return new Response("<head><title>Final</title></head>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		});

		const result = await preview("https://example.com/start", {
			fetch: fetchMock,
			followMetaRefresh: true,
		});

		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://example.com/interstitial",
				type: "http",
				ok: true,
			},
			{
				from: "https://example.com/interstitial",
				to: "https://example.com/final",
				type: "meta-refresh",
				ok: true,
			},
		]);
		expect(result.url).toBe("https://example.com/final");
		expect(result.title).toBe("Final");
	});

	it("reports an empty trail when the URL is fetched directly", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("<head><title>Direct</title></head>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		);

		const result = await preview("https://example.com/page", {
			fetch: fetchMock,
		});

		expect(result.redirects).toEqual([]);
	});

	it("records a blocked meta refresh target and keeps the original metadata", async () => {
		const interstitial = `<html><head>
			<title>Interstitial</title>
			<meta http-equiv="refresh" content="0; url=http://127.0.0.1/internal">
		</head></html>`;
		const fetchMock = vi.fn(
			async () =>
				new Response(interstitial, {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		);

		const result = await preview("https://example.com/start", {
			fetch: fetchMock,
			followMetaRefresh: true,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.title).toBe("Interstitial");
		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "http://127.0.0.1/internal",
				type: "meta-refresh",
				ok: false,
				errorCode: "PRIVATE_NETWORK_BLOCKED",
			},
		]);
	});

	it("records an unreachable meta refresh target as a network failure", async () => {
		const interstitial = `<html><head>
			<title>Still here</title>
			<meta http-equiv="refresh" content="0; url=https://example.com/gone">
		</head></html>`;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			if (String(input) === "https://example.com/gone")
				throw new TypeError("fetch failed");
			return new Response(interstitial, {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		});

		const result = await preview("https://example.com/start", {
			fetch: fetchMock,
			followMetaRefresh: true,
		});

		expect(result.title).toBe("Still here");
		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://example.com/gone",
				type: "meta-refresh",
				ok: false,
				errorCode: "NETWORK_ERROR",
			},
		]);
	});

	it("attributes a failure after a meta refresh to the failing hop, not the meta hop", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === "https://example.com/start")
				return new Response(
					`<head><title>Start</title><meta http-equiv="refresh" content="0; url=https://example.com/interstitial"></head>`,
					{ status: 200, headers: { "content-type": "text/html" } },
				);
			if (url === "https://example.com/interstitial")
				return new Response(null, {
					status: 302,
					headers: { location: "http://127.0.0.1/internal" },
				});
			throw new Error(`unexpected request: ${url}`);
		});

		const result = await preview("https://example.com/start", {
			fetch: fetchMock,
			followMetaRefresh: true,
		});

		expect(result.title).toBe("Start");
		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://example.com/interstitial",
				type: "meta-refresh",
				ok: true,
			},
			{
				from: "https://example.com/interstitial",
				to: "http://127.0.0.1/internal",
				type: "http",
				ok: false,
				errorCode: "PRIVATE_NETWORK_BLOCKED",
			},
		]);
	});

	it("reports the non-HTML trailing redirect for direct media responses", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			if (String(input) === "https://example.com/start")
				return new Response(null, {
					status: 302,
					headers: { location: "https://example.com/image.png" },
				});
			return new Response(null, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		});

		const result = await preview("https://example.com/start", {
			fetch: fetchMock,
		});

		expect(result.image).toBe("https://example.com/image.png");
		expect(result.redirects).toEqual([
			{
				from: "https://example.com/start",
				to: "https://example.com/image.png",
				type: "http",
				ok: true,
			},
		]);
	});
});
