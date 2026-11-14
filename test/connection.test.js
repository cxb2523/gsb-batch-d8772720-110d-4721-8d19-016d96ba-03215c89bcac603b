/*
 * Copyright (c) 2026.  atagon GmbH.  All rights reserved.
 *
 * This file is part of the atagon codebase and may not be copied,
 *  distributed, or modified without explicit written permission from
 * atagon GmbH. https://www.atagon.com
 *
 */

/*
 * Local, network-free tests for the proxy's reconnect behaviour.
 *
 * The "app" is a real MCP-over-HTTP server running on 127.0.0.1 (`fakeApp.js`),
 * so the real SDK client/transport code paths are exercised. What is controlled
 * is the lifecycle: when the app exits, whether it can be restarted, and when a
 * connection is dropped mid-request.
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {AppConnection, isConnectionFailure} from "../connection.js";
import {startFakeApp} from "../test-support/fakeApp.js";

/** Allocates a port, then releases it so the fake app can bind it. */
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

/**
 * Fake app process supervisor: keeps the instance alive until `stop()`, and
 * either starts a fresh instance on the next spawn or refuses to start at all.
 */
function createAppSupervisor() {
    const supervisor = {
        /** Every AppProcessHandle handed to the proxy, in spawn order. */
        handles: [],
        /** Connected fake app instances, in spawn order. */
        apps: [],
        spawnCount: 0,
        failSpawns: false,
        /** Set to a message to make the next spawn fail once. */
        failNextSpawn: null,
        /** Optional hook run after an app instance is listening. */
        onStarted: null,

        async spawnApp(port) {
            supervisor.spawnCount += 1;

            const failure = supervisor.failNextSpawn ?? (supervisor.failSpawns ? "spawn failed (configured)" : null);
            if (failure) {
                supervisor.failNextSpawn = null;
                throw new Error(failure);
            }

            const app = await startFakeApp({port, label: `app#${supervisor.spawnCount}`});
            supervisor.apps.push(app);
            await supervisor.onStarted?.(app, port);

            const handle = {
                port,
                label: app.label,
                app,
                kill() {
                    app.stop();
                },
                onExit(handler) {
                    app.onExit(handler);
                },
            };
            supervisor.handles.push(handle);
            return handle;
        },

        /** Kills the most recently spawned app as an unexpected crash would. */
        stopLatest() {
            const handle = supervisor.handles[supervisor.handles.length - 1];
            assert.ok(handle, "expected an app to have been spawned");
            handle.app.stop();
            return handle;
        },

        async cleanup() {
            for (const handle of supervisor.handles) {
                handle.app.stop();
            }
        },
    };

    return supervisor;
}

/** Real MCP client factory, matching what the proxy uses in production. */
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

/**
 * Builds an AppConnection wired to the fake app supervisor.
 *
 * @param {ReturnType<typeof createAppSupervisor>} supervisor
 * @param {{preferredPort?: number, logger?: (...args: unknown[]) => void}} [options]
 */
function createConnection(supervisor, {preferredPort = 4239, logger = () => {}} = {}) {
    return new AppConnection({
        preferredPort,
        findFreePort: freePort,
        spawnApp: (port) => supervisor.spawnApp(port),
        waitForAppReady: async (url) => {
            const response = await fetch(url, {method: "GET"});
            await response.body?.cancel();
        },
        createClient,
        logger,
    });
}

const echoRequest = (value) => ({method: "tools/call", params: {name: "echo", arguments: {value}}});

test("forwards a tool call to a running app unchanged", async (t) => {
    const supervisor = createAppSupervisor();
    const connection = createConnection(supervisor);
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    const result = await connection.callTool(echoRequest("hello"));

    assert.equal(supervisor.spawnCount, 1);
    assert.deepEqual(result, {
        content: [{type: "text", text: JSON.stringify({servedBy: "app#1", args: {value: "hello"}})}],
    });

    // The result must be passed through verbatim, not re-wrapped.
    assert.equal("isError" in result, false);
});

test("forwards a tool-level isError result unchanged instead of treating it as a failure", async (t) => {
    const supervisor = createAppSupervisor();
    const connection = createConnection(supervisor);
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    const result = await connection.callTool({method: "tools/call", params: {name: "tool_failure", arguments: {}}});

    assert.deepEqual(result, {
        content: [{type: "text", text: "tool failed in app#1"}],
        isError: true,
    });
    assert.equal(supervisor.spawnCount, 1, "a tool-level error must not trigger a reconnect");
});

test("restarts the app, reconnects, and replays the call after the app exits", async (t) => {
    const supervisor = createAppSupervisor();
    const connection = createConnection(supervisor);
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    const first = await connection.callTool(echoRequest("before"));
    assert.match(first.content[0].text, /app#1/);
    const firstPort = supervisor.apps[0].port;

    // The user closes the app (or it crashes) between two tool calls.
    supervisor.stopLatest();
    await new Promise((resolve) => setImmediate(resolve));

    const second = await connection.callTool(echoRequest("after"));

    assert.equal(supervisor.spawnCount, 2, "a new app instance must be spawned");
    assert.deepEqual(second, {
        content: [{type: "text", text: JSON.stringify({servedBy: "app#2", args: {value: "after"}})}],
    });
    assert.equal(connection.connected, true);
    assert.notEqual(supervisor.apps[1].port, firstPort, "the replacement app should pick a fresh port");
});

test("replays the same call when the connection drops mid-request", async (t) => {
    const supervisor = createAppSupervisor();
    const connection = createConnection(supervisor);
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    // First call establishes the connection; the next request has its socket
    // destroyed while it is being handled, so the response never arrives.
    await connection.callTool(echoRequest("warmup"));
    supervisor.apps[0].interruptArmed = true;

    // The app process itself is still "alive" here, so only the transport error
    // can reveal the broken connection.
    const result = await connection.callTool(echoRequest("during-drop"));

    assert.equal(supervisor.spawnCount, 2);
    assert.deepEqual(JSON.parse(result.content[0].text), {
        servedBy: "app#2",
        args: {value: "during-drop"},
    });
    assert.equal(result.isError, undefined);
});

test("replays the same call when the app crashes without reporting an exit", async (t) => {
    const supervisor = createAppSupervisor();
    const connection = createConnection(supervisor);
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    await connection.callTool(echoRequest("warmup"));

    // The process disappears without the proxy seeing an exit event, so only
    // the failed request can reveal it.
    supervisor.apps[0].crash();
    await new Promise((resolve) => setImmediate(resolve));

    const result = await connection.callTool(echoRequest("after-crash"));

    assert.equal(supervisor.spawnCount, 2);
    assert.deepEqual(JSON.parse(result.content[0].text), {
        servedBy: "app#2",
        args: {value: "after-crash"},
    });
    assert.equal(result.isError, undefined);
});

test("concurrent callers that both hit a dead app still perform only one reconnect", async (t) => {
    const supervisor = createAppSupervisor();
    const connection = createConnection(supervisor);
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    await connection.callTool(echoRequest("warmup"));

    // The app dies without the proxy learning about it; both callers discover
    // the same broken client independently.
    supervisor.apps[0].crash();
    await new Promise((resolve) => setImmediate(resolve));

    const results = await Promise.all([
        connection.callTool(echoRequest("a")),
        connection.callTool(echoRequest("b")),
    ]);

    assert.equal(supervisor.spawnCount, 2, "the two callers must share one reconnect");
    for (const [index, result] of results.entries()) {
        assert.equal(result.isError, undefined);
        assert.equal(JSON.parse(result.content[0].text).servedBy, "app#2");
        assert.equal(JSON.parse(result.content[0].text).args.value, index === 0 ? "a" : "b");
    }
});

test("returns an explicit error result (not a throw) when the app cannot be restarted", async (t) => {
    const supervisor = createAppSupervisor();
    const errors = [];
    const connection = createConnection(supervisor, {logger: (...args) => errors.push(args)});
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    await connection.callTool(echoRequest("before"));
    supervisor.failSpawns = true;
    supervisor.stopLatest();
    await new Promise((resolve) => setImmediate(resolve));

    const result = await connection.callTool(echoRequest("after"));

    assert.equal(supervisor.spawnCount, 2);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /was not executed/);
    assert.match(result.content[0].text, /not a result from the browser tool/);
    assert.match(result.content[0].text, /spawn failed/);
    assert.equal(connection.connected, false);
});

test("returns an explicit error result when the restarted app never becomes ready", async (t) => {
    const supervisor = createAppSupervisor();
    // The first spawn works; every later spawn produces a process that is
    // already dead, so the HTTP endpoint never comes up.
    supervisor.onStarted = async (_app, port) => {
        if (supervisor.spawnCount > 1) {
            const app = supervisor.apps[supervisor.apps.length - 1];
            app.stop();
            // Keep the port occupied by an unrelated listener to make sure the
            // failure is reported and not silently retried forever.
            const blocker = net.createServer(() => {
            });
            await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
            t.after(() => blocker.close());
        }
    };

    const connection = createConnection(supervisor);
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    await connection.callTool(echoRequest("before"));
    supervisor.stopLatest();
    await new Promise((resolve) => setImmediate(resolve));

    const result = await connection.callTool(echoRequest("after"));

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /was not executed/);
});

test("concurrent tool calls share a single reconnect and all succeed", async (t) => {
    const supervisor = createAppSupervisor();
    const connection = createConnection(supervisor);
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    await connection.callTool(echoRequest("warmup"));
    supervisor.stopLatest();
    await new Promise((resolve) => setImmediate(resolve));

    const calls = Array.from({length: 8}, (_unused, index) => connection.callTool(echoRequest(`call-${index}`)));
    const results = await Promise.all(calls);

    assert.equal(supervisor.spawnCount, 2, "exactly one reconnect must be performed");
    assert.equal(supervisor.apps.length, 2);

    for (const [index, result] of results.entries()) {
        assert.equal(result.isError, undefined);
        assert.deepEqual(JSON.parse(result.content[0].text), {
            servedBy: "app#2",
            args: {value: `call-${index}`},
        });
    }
});

test("concurrent callers all observe the same reconnect failure", async (t) => {
    const supervisor = createAppSupervisor();
    const connection = createConnection(supervisor);
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    await connection.callTool(echoRequest("warmup"));
    supervisor.failSpawns = true;
    supervisor.stopLatest();
    await new Promise((resolve) => setImmediate(resolve));

    const results = await Promise.all(
        Array.from({length: 5}, (_unused, index) => connection.callTool(echoRequest(`call-${index}`)))
    );

    assert.equal(supervisor.spawnCount, 2, "a failed reconnect must not be attempted once per caller");
    for (const result of results) {
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /was not executed/);
    }
});

test("a spawn that throws synchronously is reported as a connection failure", async (t) => {
    const supervisor = createAppSupervisor();
    const connection = new AppConnection({
        preferredPort: 4239,
        findFreePort: freePort,
        spawnApp: () => {
            throw new Error("binary missing");
        },
        waitForAppReady: async () => {},
        createClient,
        logger: () => {},
    });
    t.after(async () => {
        await connection.close();
        await supervisor.cleanup();
    });

    const result = await connection.callTool(echoRequest("x"));

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /binary missing/);
});

test("classifies connection failures without swallowing tool errors", () => {
    assert.equal(isConnectionFailure(new Error("fetch failed")), true);
    assert.equal(isConnectionFailure(Object.assign(new Error("Zod"), {name: "ZodError"})), false);
    assert.equal(isConnectionFailure(null), false);
    assert.equal(isConnectionFailure("boom"), false);
});
