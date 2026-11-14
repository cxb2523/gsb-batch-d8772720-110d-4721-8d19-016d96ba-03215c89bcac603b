/**
 * Whether `error` was caused by the connection to the app rather than by the
 * tool that was invoked.
 *
 * Tool failures produced by the app arrive as MCP results (possibly with
 * `isError: true`) or as {@link McpError} responses, and are forwarded to the
 * caller untouched. Everything else that comes out of `client.request()`
 * (fetch failures, aborted streams, malformed HTTP responses) means we lost the
 * app, so a reconnect may help.
 *
 * Two error kinds are deliberately not retried:
 *  - request timeouts, because replaying a tool that is merely slow (or that
 *    already ran but did not answer) could execute it twice;
 *  - result validation failures ({@link ZodError}), which reconnecting cannot
 *    fix.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isConnectionFailure(error: unknown): boolean;
/**
 * Builds the tool result returned when the browser app cannot be reached.
 *
 * @param {string} toolName Name of the tool that could not be executed.
 * @param {unknown} error   Underlying failure, if any.
 * @param {string} reason   Short human-readable explanation.
 * @returns {{content: {type: string, text: string}[], isError: boolean}}
 */
export function connectionFailureResult(toolName: string, error: unknown, reason: string): {
    content: {
        type: string;
        text: string;
    }[];
    isError: boolean;
};
/**
 * Owns the app process and the MCP client used to talk to it.
 *
 * All collaborators are injected so the reconnect behaviour can be exercised
 * against a controllable fake app endpoint in tests.
 */
export class AppConnection {
    /**
     * @param {object} options
     * @param {number} options.preferredPort         Port to try first.
     * @param {(preferredPort: number) => Promise<number>} options.findFreePort
     * @param {(port: number) => Promise<AppProcessHandle> | AppProcessHandle} options.spawnApp
     * @param {(url: string) => Promise<void>} options.waitForAppReady
     * @param {(url: string) => Promise<McpClientLike>} options.createClient
     * @param {(port: number) => string} [options.buildMcpUrl]
     * @param {(...args: unknown[]) => void} [options.logger]
     */
    constructor({ preferredPort, findFreePort, spawnApp, waitForAppReady, createClient, buildMcpUrl, logger, }: {
        preferredPort: number;
        findFreePort: (preferredPort: number) => Promise<number>;
        spawnApp: (port: number) => Promise<AppProcessHandle> | AppProcessHandle;
        waitForAppReady: (url: string) => Promise<void>;
        createClient: (url: string) => Promise<McpClientLike>;
        buildMcpUrl?: (port: number) => string;
        logger?: (...args: unknown[]) => void;
    });
    _preferredPort: number;
    _findFreePort: (preferredPort: number) => Promise<number>;
    _spawnApp: (port: number) => Promise<AppProcessHandle> | AppProcessHandle;
    _waitForAppReady: (url: string) => Promise<void>;
    _createClient: (url: string) => Promise<McpClientLike>;
    _buildMcpUrl: (port: number) => string;
    _logger: (...args: unknown[]) => void;
    /** @type {AppProcessHandle | null} */
    _app: AppProcessHandle | null;
    /** @type {McpClientLike | null} */
    _client: McpClientLike | null;
    /** @type {Promise<McpClientLike> | null} */
    _connectPromise: Promise<McpClientLike> | null;
    /**
     * Clients that failed because the connection was gone. Tracked by
     * identity so a concurrent caller cannot pick up a client that another
     * caller has already found dead (and that `_discardClient()` may not
     * have replaced yet).
     *
     * @type {WeakSet<McpClientLike>}
     */
    _brokenClients: WeakSet<McpClientLike>;
    /** Port the currently running app was started on (null when not running). */
    get port(): number;
    /** Whether an app process and a usable client are currently held. */
    get connected(): boolean;
    /**
     * Returns a client for a running app, reconnecting first if necessary.
     * Concurrent callers share a single reconnect attempt.
     *
     * @returns {Promise<McpClientLike>}
     */
    ensureConnected(): Promise<McpClientLike>;
    /**
     * Runs a `tools/call` request against the app and returns its result.
     *
     * Successful results — including results that the app marked with
     * `isError: true` — are returned exactly as the app produced them. If the
     * connection died, the call is replayed once on a new connection. If
     * reconnecting (or the replay) fails, an explicit error result is returned
     * instead of throwing.
     *
     * @param {{method: string, params?: {name?: string, arguments?: unknown}}} request
     * @returns {Promise<{content: {type: string, text: string}[], isError?: boolean}>}
     */
    callTool(request: {
        method: string;
        params?: {
            name?: string;
            arguments?: unknown;
        };
    }): Promise<{
        content: {
            type: string;
            text: string;
        }[];
        isError?: boolean;
    }>;
    /**
     * Stops the app and closes the client. Safe to call more than once.
     *
     * @returns {Promise<void>}
     */
    close(): Promise<void>;
    /**
     * Synchronously stops the app process, without waiting for the client to
     * close. Used on process exit, where async work is not guaranteed to run.
     */
    killApp(): void;
    /**
     * Single-flight reconnect. Every caller that finds the connection broken
     * joins the same promise, so the app is spawned at most once per attempt.
     *
     * @returns {Promise<McpClientLike>}
     */
    _connect(): Promise<McpClientLike>;
    /**
     * Stops whatever is left over, then spawns the app on a fresh port and
     * connects a new client to it.
     *
     * @returns {Promise<McpClientLike>}
     */
    _connectFresh(): Promise<McpClientLike>;
    /**
     * Invalidates a client once a newer one takes over (or the app exits), so
     * stale callbacks cannot clobber fresh state.
     *
     * `onerror` only logs: the SDK reports transport errors there, and they are
     * not necessarily fatal (an SSE reconnect attempt, for example). Treating
     * every such error as "client invalid" would tear down a healthy app under
     * concurrent callers. Genuine breakage is detected per request instead,
     * which is what triggers the replay.
     *
     * @param {McpClientLike} client
     */
    _wireClient(client: McpClientLike): void;
    /**
     * Called when the app process is gone.
     *
     * @param {AppProcessHandle} app
     */
    _handleAppExit(app: AppProcessHandle): void;
    /**
     * Drops a client that just failed because the connection is gone, and stops
     * the app with it. The next call starts a fresh app on a fresh port.
     *
     * @param {McpClientLike} client
     */
    _discardClient(client: McpClientLike): void;
    /**
     * Stops the app and closes the client before a fresh connection is built.
     *
     * @returns {Promise<void>}
     */
    _teardown(): Promise<void>;
    /**
     * @param {AppProcessHandle} app
     */
    _killApp(app: AppProcessHandle): void;
}
/**
 * Handle on a spawned app process.
 */
export type AppProcessHandle = {
    /**
     * Assigned by AppConnection.
     */
    port?: number;
    /**
     * Requests process termination (idempotent).
     */
    kill: () => void;
    /**
     * Registers a handler for process exit; may be called more than once.
     */
    onExit: (handler: () => void) => void;
    /**
     * Why the process went away, once known.
     */
    exitReason?: () => Error | null;
};
/**
 * Minimal MCP client surface used by AppConnection.
 */
export type McpClientLike = {
    request: (request: unknown, schema: unknown) => Promise<any>;
    close: () => Promise<void>;
    onclose?: (() => void);
    onerror?: ((error: Error) => void);
};
