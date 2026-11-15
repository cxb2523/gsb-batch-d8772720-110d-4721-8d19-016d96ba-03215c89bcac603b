import type { RedirectFailureCode, RedirectStep } from "./types.js";

/** Machine-readable failure categories thrown by linkpeek. */
export type LinkpeekErrorCode =
	| "INVALID_URL"
	| "UNSUPPORTED_PROTOCOL"
	| "PRIVATE_NETWORK_BLOCKED"
	| "SENSITIVE_HEADER"
	| "INVALID_OPTIONS"
	| "TOO_MANY_REDIRECTS"
	| "TIMEOUT";

/**
 * Error thrown by `preview()` and `fetchUrl()` for invalid input, blocked
 * targets, and timeouts. Check `code` to branch on the failure category
 * instead of matching message strings.
 */
export class LinkpeekError extends Error {
	readonly code: LinkpeekErrorCode;
	/**
	 * Redirect steps observed before this error was thrown. A blocked or
	 * over-budget redirect hop appears here as a failed step even though the
	 * error itself is what reaches the caller.
	 */
	redirects: RedirectStep[] = [];

	constructor(
		code: LinkpeekErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "LinkpeekError";
		this.code = code;
	}
}

/**
 * Map a thrown value to the redirect-step failure category it represents.
 * Used both for hops rejected before a request and for hops that failed while
 * being requested.
 */
export function redirectFailureCode(
	error: unknown,
	fallback: RedirectFailureCode = "NETWORK_ERROR",
): RedirectFailureCode {
	if (!(error instanceof LinkpeekError)) return fallback;
	switch (error.code) {
		case "INVALID_URL":
		case "UNSUPPORTED_PROTOCOL":
		case "PRIVATE_NETWORK_BLOCKED":
		case "TOO_MANY_REDIRECTS":
		case "TIMEOUT":
			return error.code;
		default:
			return fallback;
	}
}
