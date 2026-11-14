/*
 * Copyright (c) 2026.  atagon GmbH.  All rights reserved.
 *
 * This file is part of the atagon codebase and may not be copied,
 *  distributed, or modified without explicit written permission from
 * atagon GmbH. https://www.atagon.com
 *
 */

/*
 * Supervises the connection between this stdio MCP proxy and the local kogiQA
 * desktop app (which speaks MCP over HTTP).
 *
 * The app is a separate process that can die at any time: the user may close
 * it, it may crash, or it may be replaced by an update. The proxy therefore
 * treats every connection as disposable:
 *
 *  - Before a tool call the connection is checked. If the app process is gone
 *    (or its MCP client was invalidated), a new free port is picked, the app is
 *    spawned again, HTTP readiness is awaited and a fresh client is built.
 *  - If the app dies between that check and the request itself, the request
 *    fails; the connection is torn down and the same tool call is replayed once
 *    on the freshly established connection.
 *  - Reconnects are single-flight: any number of concurrent tool calls share
 *    one reconnect attempt, so the app is never spawned twice and callers never
 *    compete over a shared client.
 *  - If reconnecting fails, the tool call resolves with an explicit
 *    `isError: true` tool result instead of throwing an unhandled exception, so
 *    the caller can tell "the app is not reachable" apart from "the tool
 *    itself failed".
 */

import {CallToolResultSchema, ErrorCode, McpError} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_MCP_URL_TEMPLATE = (port) => `http://localhost:${port}/mcp`;

/** How often a single tool call may be attempted (initial try + one replay). */
const MAX_ATTEMPTS = 2;

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
export function isConnectionFailure(error) {
    if (!error || typeof error !== "object") {
        return false;
    }
    const name = /** @type {{name?: unknown}} */ (error).name;
    if (name === "ZodError") {
        return false;
    }
    if (error instanceof McpError) {
        return error.code === ErrorCode.ConnectionClosed;
    }
    return true;
}

/**
 * Builds the tool result returned when the browser app cannot be reached.
 *
 * @param {string} toolName Name of the tool that could not be executed.
 * @param {unknown} error   Underlying failure, if any.
 * @param {string} reason   Short human-readable explanation.
 * @returns {{content: {type: string, text: string}[], isError: boolean}}
 */
export function connectionFailureResult(toolName, error, reason) {
    const detail = error instanceof Error
        ? error.message
        : (error === undefined || error === null ? "" : String(error));
    const text = `[kogiqa-mcp] Tool call "${toolName}" was not executed: ${reason}.`
        + (detail ? ` Details: ${detail}` : "")
        + " This is a proxy/connection failure, not a result from the browser tool.";

    return {content: [{type: "text", text}], isError: true};
}

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
    constructor({
                    preferredPort,
                    findFreePort,
                    spawnApp,
                    waitForAppReady,
                    createClient,
                    buildMcpUrl = DEFAULT_MCP_URL_TEMPLATE,
                    logger = (...args) => console.error(...args),
                }) {
        this._preferredPort = preferredPort;
        this._findFreePort = findFreePort;
        this._spawnApp = spawnApp;
        this._waitForAppReady = waitForAppReady;
        this._createClient = createClient;
        this._buildMcpUrl = buildMcpUrl;
        this._logger = logger;

        /** @type {AppProcessHandle | null} */
        this._app = null;
        /** @type {McpClientLike | null} */
        this._client = null;
        /** @type {Promise<McpClientLike> | null} */
        this._connectPromise = null;
        /**
         * Clients that failed because the connection was gone. Tracked by
         * identity so a concurrent caller cannot pick up a client that another
         * caller has already found dead (and that `_discardClient()` may not
         * have replaced yet).
         *
         * @type {WeakSet<McpClientLike>}
         */
        this._brokenClients = new WeakSet();
    }

    /** Port the currently running app was started on (null when not running). */
    get port() {
        return this._app ? this._app.port ?? null : null;
    }

    /** Whether an app process and a usable client are currently held. */
    get connected() {
        return Boolean(this._app && this._client && !this._brokenClients.has(this._client));
    }

    /**
     * Returns a client for a running app, reconnecting first if necessary.
     * Concurrent callers share a single reconnect attempt.
     *
     * @returns {Promise<McpClientLike>}
     */
    async ensureConnected() {
        if (this._client && this._app && !this._brokenClients.has(this._client)) {
            return this._client;
        }
        return this._connect();
    }

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
    async callTool(request) {
        const toolName = request?.params?.name ?? "unknown";
        let lastError = null;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            let client;
            try {
                client = await this.ensureConnected();
            } catch (error) {
                this._logger("[Proxy] Failed to start or connect to the election app:", error);
                return connectionFailureResult(
                    toolName,
                    error,
                    "the kogiQA browser app could not be started or connected to"
                );
            }

            try {
                return await client.request(request, CallToolResultSchema);
            } catch (error) {
                if (!isConnectionFailure(error)) {
                    // The tool itself failed (or its result was invalid). Surface
                    // it unchanged so it is not mistaken for a connection
                    // problem, and never replay it.
                    throw error;
                }

                this._logger("[Proxy] Tool call lost the connection to the election app:", error);
                lastError = error;
                this._discardClient(client);
            }
        }

        this._logger("[Proxy] Giving up on tool call after reconnect:", lastError);
        return connectionFailureResult(
            toolName,
            lastError,
            "the connection to the kogiQA browser app was lost and could not be re-established"
        );
    }

    /**
     * Stops the app and closes the client. Safe to call more than once.
     *
     * @returns {Promise<void>}
     */
    async close() {
        await this._teardown();
    }

    /**
     * Synchronously stops the app process, without waiting for the client to
     * close. Used on process exit, where async work is not guaranteed to run.
     */
    killApp() {
        const app = this._app;
        this._app = null;
        if (app) {
            this._killApp(app);
        }
    }

    /**
     * Single-flight reconnect. Every caller that finds the connection broken
     * joins the same promise, so the app is spawned at most once per attempt.
     *
     * @returns {Promise<McpClientLike>}
     */
    _connect() {
        if (!this._connectPromise) {
            const promise = this._connectFresh().finally(() => {
                if (this._connectPromise === promise) {
                    this._connectPromise = null;
                }
            });
            this._connectPromise = promise;
        }
        return this._connectPromise;
    }

    /**
     * Stops whatever is left over, then spawns the app on a fresh port and
     * connects a new client to it.
     *
     * @returns {Promise<McpClientLike>}
     */
    async _connectFresh() {
        await this._teardown();

        // Resolve the port right before spawning so a slow teardown cannot
        // leave us with a port that got taken in the meantime.
        const port = await this._findFreePort(this._preferredPort);
        const url = this._buildMcpUrl(port);

        this._logger(`[Proxy] Starting election app on port ${port}...`);
        const app = await this._spawnApp(port);
        app.port = port;
        this._app = app;
        app.onExit(() => this._handleAppExit(app));

        // Fail fast instead of waiting for the readiness timeout when the app
        // dies while we are waiting for its HTTP endpoint.
        const exitSignal = new Promise((_, reject) => {
            app.onExit(() => reject(describeEarlyExit(app)));
        });
        // The race below consumes this promise; this catch only prevents an
        // "unhandled rejection" if the app exits after the race is over.
        exitSignal.catch(() => {
        });

        let client = null;
        try {
            this._logger(`[Proxy] Waiting for the election app on ${url}...`);
            await Promise.race([Promise.resolve().then(() => this._waitForAppReady(url)), exitSignal]);

            if (this._app !== app) {
                throw describeEarlyExit(app);
            }

            this._logger("[Proxy] Establishing MCP connection...");
            client = await this._createClient(url);
        } catch (error) {
            // Before the first successful connect, a failure is fatal to this
            // attempt: stop the half-started app so the next attempt starts from
            // a clean state.
            if (this._app === app) {
                this._app = null;
                this._killApp(app);
            }
            if (client) {
                await closeQuietly(client, this._logger);
            }
            throw error;
        }

        // The app may have exited while createClient() was in flight; in that
        // case its exit handler already cleared the state and we must not
        // publish a client that belongs to a dead app. (No await between this
        // check and the assignment below, so no exit event can slip in.)
        if (this._app !== app) {
            await closeQuietly(client, this._logger);
            throw describeEarlyExit(app);
        }

        this._client = client;
        this._wireClient(client);

        this._logger("[Proxy] Connected to Election App HTTP endpoint.");
        return client;
    }

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
    _wireClient(client) {
        client.onclose = () => {
            if (this._client !== client) {
                return; // A newer client took over; ignore the stale event.
            }
            this._logger("[Proxy] MCP connection closed.");
            this._client = null;
        };

        client.onerror = (error) => {
            this._logger("[Proxy] MCP connection error:", error);
        };
    }

    /**
     * Called when the app process is gone.
     *
     * @param {AppProcessHandle} app
     */
    _handleAppExit(app) {
        if (this._app !== app) {
            return; // Already replaced or torn down.
        }

        this._logger("[Proxy] Election app exited. The next tool call will restart it.");
        this._app = null;

        const client = this._client;
        this._client = null;
        if (client) {
            // Reject in-flight requests right away so their callers can
            // reconnect and replay the call instead of waiting for a timeout.
            closeQuietly(client, this._logger);
        }
    }

    /**
     * Drops a client that just failed because the connection is gone, and stops
     * the app with it. The next call starts a fresh app on a fresh port.
     *
     * @param {McpClientLike} client
     */
    _discardClient(client) {
        // Mark it dead first: concurrent callers must not pick this client up
        // even if it is still stored while another caller waits for the reconnect.
        this._brokenClients.add(client);

        if (this._client !== client) {
            return; // Someone else already invalidated it (e.g. an exit event).
        }
        this._client = null;
        closeQuietly(client, this._logger);

        const app = this._app;
        this._app = null;
        if (app) {
            this._killApp(app);
        }
    }

    /**
     * Stops the app and closes the client before a fresh connection is built.
     *
     * @returns {Promise<void>}
     */
    async _teardown() {
        const app = this._app;
        this._app = null;
        if (app) {
            this._killApp(app);
        }

        const client = this._client;
        this._client = null;
        if (client) {
            await closeQuietly(client, this._logger);
        }
    }

    /**
     * @param {AppProcessHandle} app
     */
    _killApp(app) {
        try {
            app.kill();
        } catch (error) {
            this._logger("[Proxy] Failed to stop election app:", error);
        }
    }
}

/**
 * Builds the error reported when the app went away before a connection could
 * be established. Includes the underlying spawn/exit reason when the handle
 * provides one, so callers see e.g. "binary not found" rather than a generic
 * message.
 *
 * @param {AppProcessHandle} app
 * @returns {Error}
 */
function describeEarlyExit(app) {
    const reason = typeof app.exitReason === "function" ? app.exitReason() : null;
    const message = "The election app exited before the connection was established.";
    if (!reason) {
        return new Error(message);
    }
    const error = new Error(`${message} ${reason.message}`);
    error.cause = reason;
    return error;
}

/**
 * Closes a client, swallowing errors from an already-dead connection.
 *
 * @param {McpClientLike} client
 * @param {(...args: unknown[]) => void} logger
 * @returns {Promise<void>}
 */
async function closeQuietly(client, logger) {
    try {
        await client.close();
    } catch (error) {
        logger?.("[Proxy] Error while closing the app connection:", error);
    }
}

/**
 * Handle on a spawned app process.
 *
 * @typedef {object} AppProcessHandle
 * @property {number} [port]                  Assigned by AppConnection.
 * @property {() => void} kill                Requests process termination (idempotent).
 * @property {(handler: () => void) => void} onExit  Registers a handler for process exit; may be called more than once.
 * @property {() => Error | null} [exitReason]  Why the process went away, once known.
 */

/**
 * Minimal MCP client surface used by AppConnection.
 *
 * @typedef {object} McpClientLike
 * @property {(request: unknown, schema: unknown) => Promise<any>} request
 * @property {() => Promise<void>} close
 * @property {(() => void)} [onclose]
 * @property {((error: Error) => void)} [onerror]
 */
