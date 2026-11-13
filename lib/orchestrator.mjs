// Reusable collection orchestration for the HasData Google Search MCP server.
//
// Given a list of collection tasks (each naming a tool and its arguments), run them in
// order and produce one outcome record per task instead of throwing on the first
// failure. Outcomes distinguish success, concurrency throttling, expired tokens, auth
// failure, schema/validation failure and everything else. Only the concurrency case is
// retried, with an increasing wait; the non-retryable failures are recorded immediately
// with a readable reason so a caller can see exactly which step failed and why, and
// resubmit just that step afterwards.
//
// A SERP whose aiOverview carries only a pageToken (no textBlocks) automatically gets a
// follow-up AI Overview expansion task appended. Expansion failures never undo the
// already-succeeded SERP result.

import { createMcpCaller, OUTCOMES } from './mcp-client.mjs';

export { OUTCOMES };

export const SERP_TOOL = 'hasdata_google_serp_serp_getSearchResults';
export const SERP_LIGHT_TOOL = 'hasdata_google_serp_serp_light_getSearchResults';
export const AI_OVERVIEW_TOOL = 'hasdata_google_serp_ai_overview_getAiOverviewResponse';

// Tools whose payload may carry a top-level aiOverview gated behind a pageToken.
const DEFAULT_SERP_TOOLS = new Set([SERP_TOOL, SERP_LIGHT_TOOL]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// True when a successful SERP payload's aiOverview needs a separate expansion call:
// a pageToken is present but there are no textBlocks to read.
export function needsAiOverviewExpansion(payload, toolName, serpTools = DEFAULT_SERP_TOOLS) {
    if (!serpTools.has(toolName) || !payload || typeof payload !== 'object') return false;
    const overview = payload.aiOverview;
    if (!overview || typeof overview !== 'object') return false;
    const hasToken = typeof overview.pageToken === 'string' && overview.pageToken.length > 0;
    const hasBlocks = Array.isArray(overview.textBlocks) && overview.textBlocks.length > 0;
    return hasToken && !hasBlocks;
}

function normalizeTask(task) {
    // Accept { tool, params } as documented and tolerate common aliases.
    const toolName = task.tool ?? task.toolName ?? task.name;
    const params = task.params ?? task.args ?? task.arguments ?? {};
    return {
        id: task.id,
        toolName,
        params: params && typeof params === 'object' ? params : {},
        kind: 'task',
        parentIndex: null,
    };
}

// Run one task to a terminal outcome. Concurrency limits are the only condition worth
// another attempt; waits grow linearly with the attempt number. Exhausting the retry
// budget records RATE_LIMITED as the final outcome rather than throwing.
async function executeTask(task, callTool, options, hooks) {
    const { maxRetries, baseDelayMs, maxDelayMs, sleepImpl } = options;
    const calls = [];
    let attempt = 0;

    for (;;) {
        const response = await callTool(task.toolName, task.params);
        calls.push(response);
        hooks.onCall?.(response);

        if (response.outcome !== OUTCOMES.RATE_LIMITED || attempt >= maxRetries) {
            const retries = Math.min(attempt, maxRetries);
            return {
                outcome: response.outcome,
                retryable: response.retryable,
                retries,
                calls,
                reason: response.reason,
                payload: response.json,
                envelope: response.envelope,
                lastResponse: response,
            };
        }

        // Increasing backoff before the next attempt.
        const waitMs = Math.min(baseDelayMs * (attempt + 1), maxDelayMs);
        await sleepImpl(waitMs);
        attempt += 1;
    }
}

// Execute a sequence of collection tasks. Returns a full summary; never throws for a
// remote failure. The default client is created from the options, but an injected
// callTool lets tests drive the whole flow with hand-written JSON-RPC responses.
export async function runCollection(tasks, options = {}) {
    const {
        callTool: injectedCallTool,
        maxRetries = 4,
        baseDelayMs = 2_000,
        maxDelayMs = 30_000,
        // Default to the real timer but let an injected sleep (tests, custom schedulers)
        // win: destructuring the default here means ...options can still override it.
        sleepImpl: sleepImplOption,
        expandAiOverview = true,
        serpTools = DEFAULT_SERP_TOOLS,
        onOutcome = null,
        onCall = null,
    } = options;
    const sleepImpl = sleepImplOption ?? sleep;

    const callTool = injectedCallTool ?? createMcpCaller(options);
    const hooks = { onOutcome, onCall };

    // A cursor over a mutable list lets an expansion task jump the queue and run right
    // after the SERP that minted its short-lived token, ahead of later user tasks.
    const queue = tasks.map(normalizeTask);
    const results = [];
    let index = 0;
    let totalCalls = 0;
    let totalRetries = 0;
    const outcomeCounts = Object.fromEntries(Object.values(OUTCOMES).map((o) => [o, 0]));

    while (queue.length > 0) {
        const task = queue.shift();

        // Defensive validation of the task itself: a missing tool name is the same class
        // of failure as an MCP -32602 and, like it, is never retried.
        if (typeof task.toolName !== 'string' || task.toolName.length === 0) {
            const result = {
                index: index++,
                taskId: task.id ?? null,
                kind: task.kind,
                toolName: task.toolName ?? null,
                params: task.params,
                outcome: OUTCOMES.INVALID_PARAMS,
                retryable: false,
                retries: 0,
                totalAttempts: 0,
                reason: 'task has no tool name',
                payload: undefined,
                envelope: undefined,
                expansion: null,
                parentIndex: task.parentIndex,
                lastResponse: null,
            };
            results.push(result);
            outcomeCounts[result.outcome] += 1;
            onOutcome?.(result);
            continue;
        }

        const execution = await executeTask(task, callTool, { maxRetries, baseDelayMs, maxDelayMs, sleepImpl }, hooks);
        totalCalls += execution.calls.length;
        totalRetries += execution.retries;

        const result = {
            index: index++,
            taskId: task.id ?? null,
            kind: task.kind,
            toolName: task.toolName,
            params: task.params,
            outcome: execution.outcome,
            retryable: execution.retryable,
            retries: execution.retries,
            totalAttempts: execution.calls.length,
            reason: execution.reason,
            payload: execution.payload,
            envelope: execution.envelope,
            expansion: null,
            parentIndex: task.parentIndex,
            lastResponse: execution.lastResponse,
        };
        results.push(result);
        outcomeCounts[result.outcome] += 1;
        onOutcome?.(result);

        // Auto-expand a token-gated AI Overview. The expansion is its own outcome: if it
        // fails, the parent SERP stays successful and only the expansion record fails.
        if (
            expandAiOverview &&
            result.outcome === OUTCOMES.SUCCESS &&
            needsAiOverviewExpansion(result.payload, result.toolName, serpTools)
        ) {
            const pageToken = result.payload.aiOverview.pageToken;
            queue.unshift({
                id: task.id == null ? null : `${task.id}:ai-overview`,
                toolName: AI_OVERVIEW_TOOL,
                params: { pageToken },
                kind: 'ai_overview_expansion',
                parentIndex: result.index,
            });
        }
    }

    // Link each expansion back to the SERP that produced it, now that every record has
    // its stable index. Done after the loop so parent records are never mutated out of
    // order; no circular references, only indices.
    const failedResults = [];
    for (const result of results) {
        if (result.kind === 'ai_overview_expansion' && result.parentIndex !== null) {
            const parent = results[result.parentIndex];
            if (parent) {
                parent.expansion = {
                    index: result.index,
                    outcome: result.outcome,
                    reason: result.reason,
                    retries: result.retries,
                };
            }
        }
        if (result.outcome !== OUTCOMES.SUCCESS) failedResults.push(result);
    }

    // Resubmit only what failed: the original tool/params, expansion included, so a
    // caller can hand this straight back into runCollection.
    const failedTasks = failedResults.map((result) => ({
        id: result.taskId ?? undefined,
        tool: result.toolName,
        params: result.params,
        parentIndex: result.parentIndex,
    }));

    return {
        totalTasks: results.length,
        totalCalls,
        totalRetries,
        succeeded: outcomeCounts[OUTCOMES.SUCCESS],
        failed: failedResults.length,
        outcomeCounts,
        results,
        failedResults,
        failedTasks,
    };
}
