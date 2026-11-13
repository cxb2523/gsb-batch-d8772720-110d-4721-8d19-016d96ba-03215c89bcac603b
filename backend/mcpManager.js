const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const fs = require("fs-extra");
const path = require("path");

class MCPManager {
    constructor() {
        this.servers = new Map();
    }

    async init() {
        try {
            // Read mcp_config.json
            const configPath = path.join(__dirname, 'mcp_config.json');
            if (!await fs.pathExists(configPath)) {
                // Create an empty config file
                await fs.writeJson(configPath, {
                    mcpServers: {
                        // Example: "sqlite": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "/path/to/db"] }
                    }
                }, { spaces: 2 });
                console.log('[MCP] No config found. Created empty mcp_config.json.');
                return;
            }

            const config = await fs.readJson(configPath);
            const mcpServers = config.mcpServers || {};
            const serverEntries = Object.entries(mcpServers);

            if (serverEntries.length === 0) {
                console.log('[MCP] No servers configured in mcp_config.json. Skipping MCP init.');
                return;
            }

            for (const [name, serverConfig] of serverEntries) {
                try {
                    const transport = new StdioClientTransport({
                        command: serverConfig.command,
                        args: serverConfig.args,
                        env: { ...process.env, ...serverConfig.env }
                    });

                    const client = new Client({
                        name: "liya-client",
                        version: "1.0.0",
                    }, {
                        capabilities: {}
                    });

                    await client.connect(transport);
                    console.log(`[MCP] ✅ Connected to ${name}`);
                    this.servers.set(name, client);
                } catch (err) {
                    console.error(`[MCP] ❌ Failed to connect to ${name}:`, err.message);
                }
            }
        } catch (err) {
            console.error('[MCP] Init error (non-fatal):', err.message);
        }
    }

    async getTools() {
        const allTools = [];
        for (const [serverName, client] of this.servers.entries()) {
            try {
                const result = await client.listTools();
                const tools = result.tools || [];
                for (const tool of tools) {
                    // Standard MCP tool parameters schema: tool.inputSchema
                    allTools.push({
                        name: `${serverName}__${tool.name}`, // Namespaced to avoid collisions
                        description: tool.description,
                        parameters: tool.inputSchema,
                        _mcpServerName: serverName, // metadata for execution
                        _mcpToolName: tool.name
                    });
                }
            } catch (err) {
                console.error(`[MCP] Error listing tools for ${serverName}:`, err.message);
            }
        }
        return allTools;
    }

    async callTool(serverName, toolName, args) {
        const client = this.servers.get(serverName);
        if (!client) throw new Error(`MCP server ${serverName} not found`);
        const response = await client.callTool({
            name: toolName,
            arguments: args
        });

        // MCP tool calls return { content: [{ type: 'text', text: '...' }] } usually
        if (response && response.content && response.content.length > 0) {
            return response.content.map(c => c.text).join('\n');
        }
        return JSON.stringify(response);
    }
}

const manager = new MCPManager();
module.exports = manager;
