/*
 * Copyright (c) 2026.  atagon GmbH.  All rights reserved.
 *
 * This file is part of the atagon codebase and may not be copied,
 *  distributed, or modified without explicit written permission from
 * atagon GmbH. https://www.atagon.com
 *
 */

/*
 * The stdio-facing MCP server exposed to the coding agent.
 *
 * Tool calls are handed to an {@link AppConnection}, which owns the connection
 * to the desktop app and restarts it when it has died. Keeping this module free
 * of process-level side effects (spawning, stdio wiring) lets tests connect a
 * real MCP client to it over an in-memory transport.
 */

import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";

/**
 * Creates the proxy's MCP server.
 *
 * @param {object} options
 * @param {{callTool: (request: unknown) => Promise<unknown>}} options.connection
 * @param {{tools: unknown[]}} options.toolList
 * @returns {Server}
 */
export function createProxyServer({connection, toolList}) {
    const mcpServer = new Server(
        {name: 'kogiqa-webbrowser-mcp-server', version: "1.0.0"},
        {capabilities: {tools: {}}}
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        return toolList;
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        // The connection restarts the app and replays the call if the
        // connection was lost, and returns an explicit isError result when that
        // fails.
        return connection.callTool(request);
    });

    return mcpServer;
}
