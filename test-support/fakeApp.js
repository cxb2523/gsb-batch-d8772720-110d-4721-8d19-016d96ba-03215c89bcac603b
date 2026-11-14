/*
 * Copyright (c) 2026.  atagon GmbH.  All rights reserved.
 *
 * This file is part of the atagon codebase and may not be copied,
 *  distributed, or modified without explicit written permission from
 * atagon GmbH. https://www.atagon.com
 *
 */

/*
 * A controllable fake of the kogiQA desktop app: an MCP server speaking
 * Streamable HTTP on a real local port, plus a process handle shaped like the
 * one `index.js` builds for the real binary.
 *
 * Tests use it to simulate the app being alive, dying, refusing to start, and
 * crashing mid-request.
 */

import http from "node:http";
import {randomUUID} from "node:crypto";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
    {
        name: "echo",
        description: "Returns its arguments as JSON.",
        inputSchema: {type: "object", properties: {value: {}}},
    },
    {
        name: "tool_failure",
        description: "Returns an isError tool result.",
        inputSchema: {type: "object", properties: {}},
    },
];

/**
 * Builds an MCP server whose tool results include the instance label, so tests
 * can tell which app instance served a call.
 *
 * @param {string} label
 * @returns {Server}
 */
function createMcpServer(label) {
    const server = new Server(
        {name: `fake-kogiqa-app-${label}`, version: "1.0.0"},
        {capabilities: {tools: {}}}
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: TOOLS}));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        switch (request.params.name) {
            case "echo":
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({servedBy: label, args: request.params.arguments ?? null}),
                    }],
                };
            case "tool_failure":
                return {
                    content: [{type: "text", text: `tool failed in ${label}`}],
                    isError: true,
                };
            default:
                return {
                    content: [{type: "text", text: `unknown tool: ${request.params.name}`}],
                    isError: true,
                };
        }
    });

    return server;
}

/**
 * Starts a fake app on `port`.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.label]
 * @returns {Promise<FakeApp>}
 */
export async function startFakeApp({port, label}) {
    const appLabel = label ?? `app-${port}`;

    /** @type {Set<import("node:http").ServerResponse>} */
    const openResponses = new Set();
    let stopped = false;
    const exitHandlers = [];

    const destroyOpenResponses = () => {
        for (const res of openResponses) {
            res.destroy();
        }
        openResponses.clear();
    };

    // Simulates a connection dying while a request is being handled: the socket
    // is destroyed before the JSON-RPC response can be written. The app process
    // itself is still running, so only the client's transport can notice.

    const mcpServer = createMcpServer(appLabel);
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Answer directly with JSON so a destroyed socket produces a plain
        // transport error instead of an SSE stream that ends without a response.
        enableJsonResponse: true,
    });
    await mcpServer.connect(transport);

    const httpServer = http.createServer(async (req, res) => {
        openResponses.add(res);
        res.on("close", () => openResponses.delete(res));

        if (app.interruptArmed) {
            app.interruptArmed = false;
            destroyOpenResponses();
            // Drop the connection before reading the request body, so the
            // client sees a transport error and no response is produced.
            req.socket.destroy();
            return;
        }

        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            if (!res.headersSent && !res.destroyed) {
                res.writeHead(500, {"content-type": "application/json"});
                res.end(JSON.stringify({
                    jsonrpc: "2.0",
                    error: {code: -32603, message: String(error)},
                    id: null,
                }));
            }
        }
    });
    httpServer.on("clientError", (_error, socket) => socket.destroy());

    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, "127.0.0.1", () => {
            httpServer.off("error", reject);
            resolve();
        });
    });

    const app = {
        port,
        label: appLabel,
        url: `http://localhost:${port}/mcp`,
        /** When true, the next handled request has its socket destroyed. */
        interruptArmed: false,

        /** Simulates the app process exiting: frees the port and reports exit. */
        stop() {
            if (stopped) {
                return;
            }
            stopped = true;
            destroyOpenResponses();
            httpServer.closeAllConnections?.();
            httpServer.close();
            void transport.close().catch(() => {
            });
            void mcpServer.close().catch(() => {
            });
            for (const handler of exitHandlers.splice(0)) {
                handler();
            }
        },

        /**
         * Simulates a hard crash: the endpoint disappears, but the process-exit
         * notification is withheld, as when the proxy has not yet observed the
         * child process going away. Callers must discover the loss through their
         * own requests.
         */
        crash() {
            if (stopped) {
                return;
            }
            stopped = true;
            destroyOpenResponses();
            httpServer.closeAllConnections?.();
            httpServer.close();
            void transport.close().catch(() => {
            });
            void mcpServer.close().catch(() => {
            });
            exitHandlers.length = 0;
        },

        /** Alias so the app object can be used as an AppConnection handle. */
        kill() {
            app.stop();
        },

        onExit(handler) {
            if (stopped) {
                queueMicrotask(handler);
            } else {
                exitHandlers.push(handler);
            }
        },
    };

    return app;
}
