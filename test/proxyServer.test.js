/*
 * Copyright (c) 2026.  atagon GmbH.  All rights reserved.
 *
 * This file is part of the atagon codebase and may not be copied,
 *  distributed, or modified without explicit written permission from
 * atagon GmbH. https://www.atagon.com
 *
 */

/*
 * End-to-end test of the stdio-facing side: a real MCP client talks to the real
 * proxy server over an in-memory transport, and the app behind it is a real MCP
 * server on a local HTTP port that gets restarted mid-session.
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {AppConnection} from "../connection.js";
import {createProxyServer} from "../proxyServer.js";
import {startFakeApp} from "../test-support/fakeApp.js";

const TOOL_LIST = {
    tools: [{
        name: "echo",
        description: "Returns its arguments as JSON.",
        inputSchema: {type: "object", properties: {value: {}}},
    }],
};

async function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const {port} = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function createClient(url) {
    const client = new Client({name: "test-proxy", version: "1.0.0"});
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
        reconnectionOptions: {
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 30000,
            reconnectionDelayGrowFactor: 1.5,
            maxRetries: 0,
        },
    }));
    return client;
}

test("MCP client sees a replayed result after the app restarts", async (t) => {
    const apps = [];
    let spawnCount = 0;

    const connection = new AppConnection({
        preferredPort: 4239,
        findFreePort: freePort,
        spawnApp: async (port) => {
            spawnCount += 1;
            const app = await startFakeApp({port, label: `app#${spawnCount}`});
            apps.push(app);
            return app;
        },
        waitForAppReady: async (url) => {
            const response = await fetch(url, {method: "GET"});
            await response.body?.cancel();
        },
        createClient,
        logger: () => {},
    });

    const mcpServer = createProxyServer({connection, toolList: TOOL_LIST});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({name: "test-agent", version: "1.0.0"});
    await Promise.all([
        mcpServer.connect(serverTransport),
        client.connect(clientTransport),
    ]);

    t.after(async () => {
        await client.close();
        await mcpServer.close();
        await connection.close();
        for (const app of apps) {
            app.stop();
        }
    });

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["echo"]);

    const first = await client.callTool({name: "echo", arguments: {value: "one"}});
    assert.deepEqual(JSON.parse(first.content[0].text), {servedBy: "app#1", args: {value: "one"}});

    // The app dies between two tool calls.
    apps[0].stop();
    await new Promise((resolve) => setImmediate(resolve));

    const second = await client.callTool({name: "echo", arguments: {value: "two"}});
    assert.equal(spawnCount, 2);
    assert.deepEqual(JSON.parse(second.content[0].text), {servedBy: "app#2", args: {value: "two"}});
    assert.equal(second.isError, undefined);
});

test("MCP client receives an isError tool result when reconnecting fails", async (t) => {
    let spawnCount = 0;
    let failSpawns = false;
    const apps = [];

    const connection = new AppConnection({
        preferredPort: 4239,
        findFreePort: freePort,
        spawnApp: async (port) => {
            spawnCount += 1;
            if (failSpawns) {
                throw new Error("the kogiQA binary is no longer present");
            }
            const app = await startFakeApp({port, label: `app#${spawnCount}`});
            apps.push(app);
            return app;
        },
        waitForAppReady: async (url) => {
            const response = await fetch(url, {method: "GET"});
            await response.body?.cancel();
        },
        createClient,
        logger: () => {},
    });

    const mcpServer = createProxyServer({connection, toolList: TOOL_LIST});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({name: "test-agent", version: "1.0.0"});
    await Promise.all([
        mcpServer.connect(serverTransport),
        client.connect(clientTransport),
    ]);

    t.after(async () => {
        await client.close();
        await mcpServer.close();
        await connection.close();
        for (const app of apps) {
            app.stop();
        }
    });

    await client.callTool({name: "echo", arguments: {value: "one"}});

    failSpawns = true;
    apps[0].stop();
    await new Promise((resolve) => setImmediate(resolve));

    // The call resolves with a normal tool result rather than rejecting the
    // JSON-RPC request, so the agent can read the reason.
    const result = await client.callTool({name: "echo", arguments: {value: "two"}});

    assert.equal(spawnCount, 2);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /was not executed/);
    assert.match(result.content[0].text, /binary is no longer present/);
});
