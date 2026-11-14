#!/usr/bin/env node

/*
 * Copyright (c) 2026.  atagon GmbH.  All rights reserved.
 *
 * This file is part of the atagon codebase and may not be copied,
 *  distributed, or modified without explicit written permission from
 * atagon GmbH. https://www.atagon.com
 *
 *
 */

import fs from "fs";
import path from "path";
import {spawn} from "child_process";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {getAppBinPath, getFirstFreePort, waitForHttpServer} from "./helper.js";
import {extractedPath, npxDirname, preferredPort} from "./config.js";
import {ensureBinary} from "./downloadeBinary.js";
import {AppConnection} from "./connection.js";
import {createProxyServer} from "./proxyServer.js";
import printAfterStart from "./consoleOutput.js";


const toolList = JSON.parse(fs.readFileSync(path.join(npxDirname, 'toolList.json'), 'utf-8'));

const appBinPath = getAppBinPath(extractedPath);


function getMcpUrl(port) {
    return `http://localhost:${port}/mcp`;
}

async function ensureAppInstalled() {
    if (!fs.existsSync(appBinPath)) {
        console.error("[Proxy] Election app does not exists. Download it.");
    }
    await ensureBinary();
}

/**
 * Spawns the desktop app and exposes a small handle the connection supervisor
 * can use, independent of Node's ChildProcess event details.
 *
 * @param {number} port
 * @returns {import("./connection.js").AppProcessHandle}
 */
function startApp(port) {
    const child = spawn(appBinPath, [`--`, `--mcp`, `--no-auto-update`, `--mcpPort=${port}`], {
        stdio: ["ignore", "ignore", "inherit"],
    });

    // const child = spawn("npm", ["run", "local:dev:mcp", `--`, `--mcp`, `--mcpPort=${port}`], {
    //     stdio: ["ignore", "ignore", "inherit"],
    //     shell: true,
    //     cwd: path.resolve("../../desktop-client"),
    // });

    const exitHandlers = [];
    let exited = false;
    /** @type {Error | null} */
    let exitReason = null;

    const notifyExited = () => {
        if (exited) {
            return;
        }
        exited = true;
        for (const handler of exitHandlers) {
            try {
                handler();
            } catch (error) {
                console.error("[Proxy] App exit handler failed:", error);
            }
        }
        exitHandlers.length = 0;
    };

    child.on("error", (err) => {
        console.error("[Proxy] Failed to start election app:", err);
        // A failed spawn may never emit "exit"; treat it as gone so waiters
        // stop waiting and the next tool call retries.
        exitReason = err;
        notifyExited();
    });

    child.on("exit", (code, signal) => {
        console.error(`[Proxy] Election app exited (code=${code}, signal=${signal}).`);
        if (!exitReason) {
            exitReason = new Error(`The election app exited (code=${code}, signal=${signal}).`);
        }
        notifyExited();
    });

    return {
        port,
        kill() {
            if (!exited) {
                child.kill();
            }
        },
        onExit(handler) {
            if (exited) {
                // Already gone: report it asynchronously so the caller sees the
                // same ordering as a live exit event.
                queueMicrotask(handler);
            } else {
                exitHandlers.push(handler);
            }
        },
        exitReason() {
            return exitReason;
        },
    };
}

/**
 * Opens a fresh MCP client against the app's HTTP endpoint.
 *
 * @param {string} url
 * @returns {Promise<Client>}
 */
async function connectClient(url) {
    const client = new Client({name: "kogiqa-webbrowser-mcp-server-client", version: "1.0.0"});
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
        // Reconnection is handled at the tool-call level (restart app, new
        // client), so the transport must not keep retrying against a port whose
        // app is gone. Retries are still bounded to one attempt so a
        // half-delivered SSE response cannot hang the call indefinitely.
        reconnectionOptions: {
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 30000,
            reconnectionDelayGrowFactor: 1.5,
            maxRetries: 0,
        },
    }));
    return client;
}

const appConnection = new AppConnection({
    preferredPort,
    findFreePort: getFirstFreePort,
    spawnApp: startApp,
    waitForAppReady: (url) => waitForHttpServer(url),
    createClient: connectClient,
    buildMcpUrl: getMcpUrl,
});


async function startProxy() {

    const mcpServer = createProxyServer({connection: appConnection, toolList});

    const stdioTransport = new StdioServerTransport();
    await mcpServer.connect(stdioTransport);
    console.error("[Proxy] Proxy server running on stdio.");
    await printAfterStart();
}


async function main() {
    try {
        await ensureAppInstalled();

        process.on("exit", () => {
            // Best-effort synchronous cleanup: close() would need to await, and
            // Node does not run async work on "exit". child.kill() is sync.
            appConnection.killApp();
        });
        process.on("SIGINT", () => process.exit());
        process.on("SIGTERM", () => process.exit());

        await startProxy();
    } catch (error) {
        console.error("[Proxy] Fatal Error:", error);
        process.exit(1);
    }
}

main();
