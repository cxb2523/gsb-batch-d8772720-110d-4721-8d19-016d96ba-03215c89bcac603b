#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { EXTRACT_TOOL_NAME, runExtractWebData } from './extract-web-data.js';

// Create an MCP server with only tools capability (trigger 'query-data' call).
const server = new Server(
  {
    name: 'agentql-mcp',
    version: '1.0.1',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const AGENTQL_API_KEY = process.env.AGENTQL_API_KEY;

if (!AGENTQL_API_KEY) {
  // Warn but keep the server alive: each `extract-web-data` call then reports the
  // missing configuration through the tool result instead of killing the process,
  // so the caller sees an actionable explanation rather than a dropped connection.
  console.error('Warning: AGENTQL_API_KEY environment variable is not set; extract-web-data calls will fail.');
}

// Handler that lists available tools.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: EXTRACT_TOOL_NAME,
        description:
          'Extracts structured data as JSON from a web page given a URL using a Natural Language description of the data.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL of the public webpage to extract data from',
            },
            prompt: {
              type: 'string',
              description: 'Natural Language description of the data to extract from the page',
            },
          },
          required: ['url', 'prompt'],
        },
      },
    ],
  };
});

// Handler for the 'extract-web-data' tool.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case EXTRACT_TOOL_NAME: {
      // Every outcome — including missing arguments, upstream errors and network
      // failures — is reported through the tool's text content, so the caller can
      // always tell what happened.
      try {
        return await runExtractWebData(request.params.arguments, {
          apiKey: AGENTQL_API_KEY,
        });
      } catch (error) {
        // Last-resort guard: even an unexpected error must surface as a readable
        // tool outcome instead of an opaque transport-level failure.
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Extraction failed: unexpected internal error while handling '${EXTRACT_TOOL_NAME}'. Reason: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: '${request.params.name}'`);
  }
});

// Start the server using stdio transport.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
