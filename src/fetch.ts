import { Parser } from "htmlparser2";
import { LinkpeekError, redirectFailureCode } from "./errors.js";
import { createHeadBoundaryDetector } from "./parse.js";
import type {
	PreviewOptions,
	RedirectFailureCode,
	RedirectStep,
} from "./types.js";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 10;
const SENSITIVE_REQUEST_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"api-key",
	"apikey",
	"x-api-key",
	"x-api-token",
	"x-auth-token",
	"x-access-token",
	"access-token",
	"x-amz-security-token",
	"x-goog-api-key",
	"x-csrf-token",
	"x-xsrf-token",
]);

export function validateUrl(url: string, allowPrivateIPs = false): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new LinkpeekError("INVALID_URL", "Invalid URL");
	}

	if (!ALLOWED_PROTOCOLS.has(parsed.protocol))
		throw new LinkpeekError(
			"UNSUPPORTED_PROTOCOL",
			"Only http and https URLs are supported",
		);

	if (parsed.username || parsed.password)
		throw new LinkpeekError(
			"INVALID_URL",
			"URLs with embedded credentials are not allowed",
		);

	if (!allowPrivateIPs && isPrivateHost(parsed.hostname))
		throw new LinkpeekError(
			"PRIVATE_NETWORK_BLOCKED",
			"URLs pointing to private/internal networks are not allowed",
		);
}

export function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/\.$/, "");
	if (
		h === "localhost" ||
		h === "[::1]" ||
		h === "::1" ||
		h.endsWith(".local") ||
		h.endsWith(".localhost")
	)
		return true;

	const ipv4 = parseIPv4(h);
	if (ipv4) {
		return isPrivateIPv4(ipv4);
	}

	const ipv6 = h.replace(/^\[|\]$/g, "").toLowerCase();
	const ipv6Parts = parseIPv6(ipv6);
	if (ipv6Parts) return isPrivateIPv6(ipv6Parts);

	return false;
}

function parseIPv4(hostname: string): number[] | null {
	const parts = hostname.split(".");
	if (parts.length !== 4) return null;

	const bytes = parts.map((part) => {
		if (!/^\d+$/.test(part)) return Number.NaN;
		const value = Number.parseInt(part, 10);
		return value >= 0 && value <= 255 ? value : Number.NaN;
	});

	return bytes.some(Number.isNaN) ? null : bytes;
}

function isPrivateIPv4([a, b, c, d]: number[]): boolean {
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 192 && b === 0 && c === 0) return d !== 9 && d !== 10;
	if (a === 192 && b === 0 && c === 2) return true;
	if (a === 192 && b === 88 && c === 99) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a === 198 && b === 51 && c === 100) return true;
	if (a === 203 && b === 0 && c === 113) return true;
	if (a >= 224) return true;
	return false;
}

function parseIPv6(hostname: string): number[] | null {
	if (!hostname.includes(":")) return null;
	const host = hostname.split("%", 1)[0];
	const doubleColonParts = host.split("::");
	if (doubleColonParts.length > 2) return null;

	const left = parseIPv6Section(doubleColonParts[0]);
	const right = parseIPv6Section(doubleColonParts[1] ?? "");
	if (!left || !right) return null;

	const missing = 8 - left.length - right.length;
	if (doubleColonParts.length === 1 && missing !== 0) return null;
	if (doubleColonParts.length === 2 && missing < 0) return null;

	return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIPv6Section(section: string): number[] | null {
	if (!section) return [];

	const parts = section.split(":");
	const values: number[] = [];
	for (const part of parts) {
		if (!part) return null;
		if (part.includes(".")) {
			const ipv4 = parseIPv4(part);
			if (!ipv4) return null;
			values.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
			continue;
		}
		if (!/^[\da-f]{1,4}$/i.test(part)) return null;
		values.push(Number.parseInt(part, 16));
	}

	return values;
}

function isPrivateIPv6(parts: number[]): boolean {
	if (parts.length !== 8) return false;

	const [first, second] = parts;
	const isUnspecified = parts.every((part) => part === 0);
	const isLoopback =
		parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1;
	if (isUnspecified || isLoopback) return true;

	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	if (first === 0x2001 && (second & 0xfe00) === 0)
		return !isGlobalProtocolAssignment(parts); // 2001::/23
	if (first === 0x2001 && second === 0x0db8) return true; // documentation
	if (first === 0x3fff && (second & 0xf000) === 0) return true; // 3fff::/20 documentation
	if (first === 0x0100 && second === 0 && parts[2] === 0 && parts[3] === 0)
		return true; // 100::/64 discard
	if (first === 0x0100 && second === 0 && parts[2] === 0 && parts[3] === 1)
		return true; // 100:0:0:1::/64 dummy prefix
	if (first === 0x0064 && second === 0xff9b && parts[2] === 1) return true; // 64:ff9b:1::/48 local-use translation

	const isIPv4Mapped =
		parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
	if (isIPv4Mapped) {
		return isPrivateIPv4(ipv4FromWords(parts[6], parts[7]));
	}

	const isIPv4Compatible = parts.slice(0, 6).every((part) => part === 0);
	if (isIPv4Compatible) return isPrivateIPv4(ipv4FromWords(parts[6], parts[7]));

	const isIPv4Translated =
		parts.slice(0, 4).every((part) => part === 0) &&
		parts[4] === 0xffff &&
		parts[5] === 0;
	if (isIPv4Translated) return isPrivateIPv4(ipv4FromWords(parts[6], parts[7]));

	const isNat64WellKnown =
		first === 0x0064 &&
		second === 0xff9b &&
		parts.slice(2, 6).every((part) => part === 0);
	if (isNat64WellKnown) return isPrivateIPv4(ipv4FromWords(parts[6], parts[7]));

	const is6to4 = first === 0x2002;
	if (is6to4) return isPrivateIPv4(ipv4FromWords(parts[1], parts[2]));

	// IANA currently allocates only 2000::/3 for ordinary global unicast.
	// Special globally reachable translation/mapping forms return above.
	if ((first & 0xe000) !== 0x2000) return true;

	return false;
}

function isGlobalProtocolAssignment(parts: number[]): boolean {
	const [, second, third] = parts;
	if (second === 0x0001) {
		const isSpecialAddress = parts.slice(2, 7).every((part) => part === 0);
		return isSpecialAddress && parts[7] >= 1 && parts[7] <= 3;
	}
	if (second === 0x0003) return true; // 2001:3::/32
	if (second === 0x0004 && third === 0x0112) return true; // 2001:4:112::/48
	if ((second & 0xfff0) === 0x0020) return true; // 2001:20::/28
	if ((second & 0xfff0) === 0x0030) return true; // 2001:30::/28
	return false;
}

function ipv4FromWords(high: number, low: number): number[] {
	return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

const DEFAULT_TIMEOUT = 8000;
const MAX_TIMEOUT = 2_147_483_647;
const DEFAULT_MAX_BYTES = 30_000;
const DEFAULT_USER_AGENT = "Twitterbot/1.0";

export interface FetchResult {
	html: string;
	finalUrl: string;
	contentType: string;
	isHtml: boolean;
	statusCode: number;
	/** Redirect steps observed during this fetch, in order. Shared with the caller's trace array. */
	redirects: RedirectStep[];
}

/**
 * Cross-request state for one preview: the shared ordered trail, the origin
 * custom headers were issued to, and a step the caller already recorded whose
 * target this fetch requests first.
 */
export interface FetchContext {
	headerOrigin?: string;
	trace?: RedirectStep[];
	/**
	 * A step already pushed to `trace` (e.g. a meta refresh) that this fetch
	 * follows. It is marked ok as soon as the first response arrives, so a
	 * failure deeper in the chain is attributed only to the failing hop.
	 */
	pendingStep?: RedirectStep;
}

/**
 * Fetch a URL with a streaming body, stopping after the head when possible and
 * always enforcing maxBytes on retained decoded response-body bytes.
 * Returns the HTML string and metadata about the response.
 *
 * `context.trace` optionally receives every redirect step in order. Passing the
 * same array to consecutive fetches (HTTP then meta-refresh) yields one ordered
 * trace; it is filled even when this function throws. For backward compatibility
 * a bare origin string is still accepted as `headerOrigin`.
 */
export async function fetchUrl(
	url: string,
	options: PreviewOptions = {},
	context: FetchContext | string = {},
): Promise<FetchResult> {
	validateUrl(url, options.allowPrivateIPs);
	const {
		trace,
		headerOrigin,
		pendingStep: initialStep,
	} = typeof context === "string"
		? { trace: undefined, headerOrigin: context, pendingStep: undefined }
		: context;
	const redirects = trace ?? [];
	const timeout = normalizeTimeout(options.timeout ?? DEFAULT_TIMEOUT);
	const maxBytes = normalizeMaxBytes(options.maxBytes ?? DEFAULT_MAX_BYTES);
	const maxRedirects = normalizeMaxRedirects(
		options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
	);
	const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
	const fetchImpl = options.fetch ?? fetch;
	const headers = buildRequestHeaders(userAgent, options.headers);
	// Custom headers stay on the starting origin; cross-origin redirects get
	// defaults only so per-site headers cannot leak to arbitrary hosts.
	const crossOriginHeaders = options.headers
		? buildRequestHeaders(userAgent, undefined)
		: headers;
	const startOrigin = headerOrigin ?? new URL(url).origin;

	if (options.signal?.aborted) {
		throw (
			options.signal.reason ??
			new DOMException("This operation was aborted", "AbortError")
		);
	}

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeout);
	const onExternalAbort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });

	try {
		let currentUrl = url;
		let redirectCount = 0;
		// The step whose target is currently being requested. It stays pending
		// until its target answer is fully used (redirect followed, or body
		// read finished) so a timeout during the body read marks that hop.
		let pendingStep: RedirectStep | null = initialStep ?? null;
		const settleStep = () => {
			if (pendingStep) {
				pendingStep.ok = true;
				pendingStep = null;
			}
		};

		while (true) {
			const sameOrigin = new URL(currentUrl).origin === startOrigin;
			let response: Response;
			try {
				response = await fetchImpl(currentUrl, {
					headers: sameOrigin ? headers : crossOriginHeaders,
					redirect: "manual",
					signal: controller.signal,
				});
			} catch (error) {
				// The target was requested but never answered: mark that hop.
				if (pendingStep)
					pendingStep.errorCode = fetchFailureCode(
						error,
						timedOut,
						options.signal,
					);
				throw error;
			}

			if (
				options.followRedirects !== false &&
				REDIRECT_STATUSES.has(response.status)
			) {
				const location = response.headers.get("location");
				if (location) {
					await response.body?.cancel().catch(() => {});
					// Reaching the redirect response fulfills this hop; the next
					// hop owns whatever happens after it.
					settleStep();
					let nextUrl: string | null = null;
					try {
						nextUrl = new URL(location, currentUrl).href;
					} catch {
						/* Reported below; keep the raw Location as the step target. */
					}
					// Preserve the existing precedence: the budget is checked
					// before Location validity.
					if (redirectCount >= maxRedirects) {
						redirects.push({
							from: currentUrl,
							to: nextUrl ?? location,
							type: "http",
							ok: false,
							errorCode: "TOO_MANY_REDIRECTS",
						});
						throw new LinkpeekError("TOO_MANY_REDIRECTS", "Too many redirects");
					}
					if (!nextUrl) {
						redirects.push({
							from: currentUrl,
							to: location,
							type: "http",
							ok: false,
							errorCode: "INVALID_URL",
						});
						throw new LinkpeekError("INVALID_URL", "Invalid URL");
					}
					try {
						validateUrl(nextUrl, options.allowPrivateIPs);
					} catch (error) {
						// Record the hop we refuse to request, then surface the
						// original validation error (and its code).
						redirects.push({
							from: currentUrl,
							to: nextUrl,
							type: "http",
							ok: false,
							errorCode: redirectFailureCode(error),
						});
						throw error;
					}
					pendingStep = {
						from: currentUrl,
						to: nextUrl,
						type: "http",
						ok: false,
					};
					redirects.push(pendingStep);
					currentUrl = nextUrl;
					redirectCount++;
					continue;
				}
			}

			const fetched = await readFetchResponse(
				response,
				currentUrl,
				maxBytes,
				options.includeBodyContent !== true,
				redirects,
			);
			// The body was read (or deliberately not needed), so the hop that
			// led here really landed.
			settleStep();
			return fetched;
		}
	} catch (err) {
		// A redirect target that was requested but never answered is a failed
		// step, whether or not the thrown error is a LinkpeekError.
		const failureCode = fetchFailureCode(err, timedOut, options.signal);
		for (const step of redirects) {
			if (!step.ok && !step.errorCode) step.errorCode = failureCode;
		}
		if (err instanceof LinkpeekError) {
			err.redirects = redirects;
			throw err;
		}
		if (timedOut)
			throw appendTrace(
				new LinkpeekError("TIMEOUT", `Request timed out after ${timeout}ms`, {
					cause: err,
				}),
				redirects,
			);
		throw appendTrace(err, redirects);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onExternalAbort);
	}
}

/**
 * Attach the observed trail to errors that cannot expose it directly (native
 * TypeError from fetch, caller abort reasons). Non-object errors pass through.
 */
function appendTrace<T>(error: T, redirects: RedirectStep[]): T {
	if (!error || typeof error !== "object" || !Object.isExtensible(error)) {
		return error;
	}
	if ("redirects" in error) {
		(error as { redirects: RedirectStep[] }).redirects = redirects;
	} else {
		// Native TypeError / caller abort reason: define non-enumerably so
		// existing serialization and equality checks stay unchanged.
		Object.defineProperty(error, "redirects", {
			value: redirects,
			configurable: true,
			writable: true,
		});
	}
	return error;
}

function fetchFailureCode(
	error: unknown,
	timedOut: boolean,
	signal: PreviewOptions["signal"],
): RedirectFailureCode {
	if (timedOut) return "TIMEOUT";
	if (error instanceof LinkpeekError) return redirectFailureCode(error);
	if (signal?.aborted) return "ABORTED";
	return "NETWORK_ERROR";
}

function normalizeMaxBytes(maxBytes: number): number {
	if (!Number.isFinite(maxBytes)) {
		throw new LinkpeekError(
			"INVALID_OPTIONS",
			"maxBytes must be a finite number",
		);
	}
	return Math.max(0, Math.floor(maxBytes));
}

function normalizeTimeout(timeout: number): number {
	if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_TIMEOUT) {
		throw new LinkpeekError(
			"INVALID_OPTIONS",
			`timeout must be between 0 and ${MAX_TIMEOUT} milliseconds`,
		);
	}
	return timeout;
}

function normalizeMaxRedirects(maxRedirects: number): number {
	if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
		throw new LinkpeekError(
			"INVALID_OPTIONS",
			"maxRedirects must be a non-negative integer",
		);
	}
	return maxRedirects;
}

function buildRequestHeaders(
	userAgent: string,
	headers: Record<string, string> | undefined,
): Record<string, string> {
	const requestHeaders: Record<string, string> = {
		"User-Agent": userAgent,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.5",
	};

	for (const [name, value] of Object.entries(headers ?? {})) {
		const headerName = name.trim();
		if (isSensitiveRequestHeader(headerName)) {
			throw new LinkpeekError(
				"SENSITIVE_HEADER",
				"Sensitive request headers are not allowed",
			);
		}
		// Replace defaults case-insensitively so e.g. "user-agent" overrides
		// "User-Agent" instead of fetch merging both into one header.
		const normalized = headerName.toLowerCase();
		for (const existing of Object.keys(requestHeaders)) {
			if (existing.toLowerCase() === normalized)
				delete requestHeaders[existing];
		}
		requestHeaders[headerName] = value;
	}

	return requestHeaders;
}

function isSensitiveRequestHeader(name: string): boolean {
	const normalized = name.toLowerCase();
	return (
		SENSITIVE_REQUEST_HEADERS.has(normalized) ||
		normalized.endsWith("-authorization")
	);
}

async function readFetchResponse(
	response: Response,
	currentUrl: string,
	maxBytes: number,
	stopAfterHead: boolean,
	redirects: RedirectStep[],
): Promise<FetchResult> {
	const finalUrl = response.url || currentUrl;
	const statusCode = response.status;
	const contentType = response.headers.get("content-type") || "";
	const normalizedContentType = contentType.toLowerCase();
	const isHtml =
		normalizedContentType.includes("text/html") ||
		normalizedContentType.includes("xhtml");

	if (!isHtml || !response.body || maxBytes === 0) {
		// Drain unused bodies so the connection is released immediately.
		response.body?.cancel().catch(() => {});
		return { html: "", finalUrl, contentType, isHtml, statusCode, redirects };
	}

	// Stream body with byte limit
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	const headDetector = stopAfterHead ? createHeadBoundaryDetector() : null;
	let headDecoder: TextDecoder | null = null;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const remaining = maxBytes - totalBytes;
		if (remaining <= 0) break;
		const chunk = value.length > remaining ? value.slice(0, remaining) : value;
		chunks.push(chunk);
		totalBytes += chunk.length;

		if (headDetector) {
			if (headDecoder) {
				headDetector.write(headDecoder.decode(chunk, { stream: true }));
			} else if (totalBytes >= 3 || totalBytes >= maxBytes) {
				// Wait only for a possible split BOM. ASCII-compatible encodings
				// share the head markup; final text decoding uses the full prescan.
				const buffered = combineChunks(chunks, totalBytes);
				headDecoder = createTextDecoder(detectCharset(contentType, buffered));
				headDetector.write(headDecoder.decode(buffered, { stream: true }));
			}
			if (headDetector.headClosed) break;
		}
		if (totalBytes >= maxBytes) break;
	}
	reader.cancel().catch(() => {});

	const combined = combineChunks(chunks, totalBytes);
	if (headDetector && !headDecoder && totalBytes > 0) {
		headDecoder = createTextDecoder(detectCharset(contentType, combined));
		headDetector.write(headDecoder.decode(combined, { stream: true }));
	}

	const charset = detectCharset(contentType, combined);
	const html = createTextDecoder(charset).decode(combined);

	return { html, finalUrl, contentType, isHtml, statusCode, redirects };
}

function combineChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}
	return combined;
}

function createTextDecoder(charset: string): TextDecoder {
	try {
		return new TextDecoder(charset, { fatal: false });
	} catch {
		// Unknown charset — fall back to utf-8
		return new TextDecoder("utf-8", { fatal: false });
	}
}

function extractHeaderCharset(contentType: string): string | null {
	return contentType.match(/charset=["']?([^"'\s;]+)/i)?.[1] ?? null;
}

// How many leading bytes to scan for a <meta charset> declaration when the
// Content-Type header does not specify one (mirrors browser prescan behavior).
const CHARSET_PRESCAN_BYTES = 1024;

function detectCharset(contentType: string, bytes: Uint8Array): string {
	// A BOM takes precedence over HTTP and document declarations.
	// Byte order marks
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	)
		return "utf-8";
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
		return "utf-16le";
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
		return "utf-16be";

	const headerCharset = extractHeaderCharset(contentType);
	if (headerCharset) return headerCharset;

	// Parse only the bounded prescan: comments and raw script/style text must
	// not masquerade as encoding declarations.
	let charset: string | null = null;
	let templateDepth = 0;
	const parser = new Parser(
		{
			onopentag(name, attrs) {
				if (name === "template") templateDepth++;
				if (templateDepth || name !== "meta") return;
				const candidate =
					attrs.charset ||
					((attrs["http-equiv"] || "").toLowerCase() === "content-type"
						? extractHeaderCharset(attrs.content || "")
						: null);
				if (!candidate) return;
				try {
					const encoding = new TextDecoder(candidate).encoding;
					// HTML meta declarations cannot switch an ASCII document to UTF-16.
					charset = encoding.startsWith("utf-16") ? "utf-8" : encoding;
					parser.pause();
				} catch {
					/* Ignore unsupported declarations and continue scanning. */
				}
			},
			onclosetag(name) {
				if (name === "template" && templateDepth) templateDepth--;
			},
		},
		{ decodeEntities: true },
	);
	parser.write(
		new TextDecoder("latin1").decode(bytes.subarray(0, CHARSET_PRESCAN_BYTES)),
	);
	if (charset) return charset;

	return "utf-8";
}
