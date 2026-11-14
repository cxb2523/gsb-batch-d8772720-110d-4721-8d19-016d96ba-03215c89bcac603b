/**
 * Creates the proxy's MCP server.
 *
 * @param {object} options
 * @param {{callTool: (request: unknown) => Promise<unknown>}} options.connection
 * @param {{tools: unknown[]}} options.toolList
 * @returns {Server}
 */
export function createProxyServer({ connection, toolList }: {
    connection: {
        callTool: (request: unknown) => Promise<unknown>;
    };
    toolList: {
        tools: unknown[];
    };
}): Server;
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
