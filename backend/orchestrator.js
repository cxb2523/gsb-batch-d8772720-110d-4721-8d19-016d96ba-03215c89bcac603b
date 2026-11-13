/**
 * Backend Orchestrator for Liya (Production Grade)
 */

const { Ollama } = require('ollama');
const { tools } = require('./toolEngine');
const fs = require('fs-extra');
const path = require('path');
const { getBackendApiKey } = require('./configHelper');

async function planAndExecuteBackend(query, onChunk, options = {}) {
    const { onProgress } = options;
    const reportProgress = (msg) => {
        if (onProgress) onProgress(msg);
        console.log(`[Orchestrator Progress] ${msg}`);
    };

    // Intelligent Routing Logic — Simplified for Browse and Specific Tasks
    const classifyQuery = (text) => {
        if (!text) return 'fast';
        const t = text.toLowerCase();
        // Coding
        if (/\b(code|program|debug|fix|refactor|implement|script|html|css|javascript|python)\b/i.test(t)) return 'coder';
        // Complex reasoning
        const complexKeywords = ['plan', 'analyze', 'explain', 'architecture', 'system', 'database', 'design', 'research', 'browse', 'deep'];
        if (complexKeywords.some(k => t.includes(k))) return 'smart';
        return 'fast';
    };

    const BACKEND_MODEL_MAP = {
        fast:        process.env.OLLAMA_FAST_MODEL || 'gpt-oss:20b-cloud',
        smart:       process.env.OLLAMA_SMART_MODEL || 'cogito-2.1:671b-cloud',
        coder:       process.env.VITE_CODER_MODEL || 'gpt-os:120b-cloud',
    };

    const getBackendModel = (query, hasImage, uiModel) => {
        // UI Selected Model has highest priority
        if (uiModel) return uiModel;
        if (hasImage) return process.env.VISION_MODEL || 'qwen3-vl:235b-instruct-cloud';
        if (process.env.OLLAMA_MODEL) return process.env.OLLAMA_MODEL;
        const classification = classifyQuery(query);
        console.log(`[Orchestrator] Query classified as: ${classification}`);
        return BACKEND_MODEL_MAP[classification] || BACKEND_MODEL_MAP.smart;
    };

    try {
        let apiKey = options.apiKey || getBackendApiKey('VITE_OLLAMA_CLOUD_API_KEY');
        
        // Retry logic: If API key is not found, retry up to 4 times (waiting 5 seconds between checks)
        let keyRetries = 0;
        const MAX_KEY_RETRIES = 4;
        while (!apiKey && keyRetries < MAX_KEY_RETRIES) {
            console.log(`[Orchestrator] API key not found. Retrying in 5s... (Attempt ${keyRetries + 1}/${MAX_KEY_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            apiKey = getBackendApiKey('VITE_OLLAMA_CLOUD_API_KEY');
            keyRetries++;
        }
        
        if (!apiKey) {
            throw new Error("Unauthorized: Ollama API key is missing. Please supply it via Web UI or configure .env.");
        }

        const model = getBackendModel(query, !!options.imageBase64, options.model);

        const ollama = new Ollama({
            host: 'https://api.ollama.com',
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        const { searchMemories } = require('./memoryHandler');
        const memoryContext = await searchMemories(query, options.userId) || "";

        const now = new Date();
        const timeString = now.toLocaleString('en-IN', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true
        });
        const systemTimeContext = `[System Time: ${timeString}]`;

        // 1. Fetch System Prompt — robust approach with fallbacks
        const promptsPath = path.resolve(__dirname, '../src/utils/prompts.js');
        let systemPromptText = "";
        try {
            // Try dedicated plain-text prompt file first
            const plainPromptPath = path.resolve(__dirname, '../brain/system_prompt.txt');
            if (await fs.pathExists(plainPromptPath)) {
                systemPromptText = await fs.readFile(plainPromptPath, 'utf8');
            } else {
                const content = await fs.readFile(promptsPath, 'utf8');
                // Broader regex that handles various formatting styles
                const match = content.match(/(?:LIYA_SYSTEM_PROMPT|SYSTEM_PROMPT)\s*=\s*`([\s\S]*?)`\s*;/);
                if (match) systemPromptText = match[1];
            }
        } catch (e) {
            console.warn("Could not load full system prompt, using fallback.");
            systemPromptText = `You are Liya, an advanced AI Personal Assistant created by Navraj Singh. You are now serving ${process.env.VITE_USER_NAME || 'Navraj'}.`;
        }

        const manifest = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

        const orchestratorPrompt = `
You are Liya's intelligent orchestrator. Your creator is Navraj Singh.
Available tools: ${JSON.stringify(manifest)}

Rules:
1. Identify if the user needs tool usage.
2. IMPORTANT: Use your internal knowledge for general facts, history, science, philosophy, and casual conversation. 
3. ONLY use the 'research' tool if:
   - The information is real-time (news, stock prices, weather).
   - The query involves a URL ($VITE_LINK).
   - The fact is likely to have changed after your knowledge cutoff (post-2023).
   - You are highly uncertain and need verification.
5. If tool usage is needed, respond ONLY with JSON: { "thought": "Reasoning", "selected_tools": [{ "name": "tool_name", "parameters": { ... } }] }
6. If no tool is needed, respond with text answer.

Query: ${query}
${options.imageHint ? `[SYSTEM_HINT: ${options.imageHint}]` : ""}
${systemTimeContext}
${memoryContext ? `[Relevant Memories]:\n${memoryContext}` : ""}
`;

        // 1. PLANNING (with 30s timeout guard and up to 4 retries on failure)
        const PLANNING_TIMEOUT_MS = 30000;
        let response;
        let apiRetries = 0;
        const MAX_API_RETRIES = 4;
        
        while (apiRetries < MAX_API_RETRIES) {
            try {
                const planPromise = ollama.chat({
                    model: model,
                    messages: [{ role: 'user', content: orchestratorPrompt }],
                    stream: false,
                    options: {
                        num_predict: 2048
                    }
                });
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('PLANNING_TIMEOUT')), PLANNING_TIMEOUT_MS);
                });
                response = await Promise.race([planPromise, timeoutPromise]);
                break; // success, break out of loop
            } catch (err) {
                if (err.message === 'PLANNING_TIMEOUT') {
                    console.warn(`[Orchestrator] Planning timed out after ${PLANNING_TIMEOUT_MS/1000}s. Skipping tools.`);
                    // Skip to final response without tool execution
                    const fallbackMessages = [
                        { role: 'system', content: `${systemPromptText}\n\n${systemTimeContext}\n${memoryContext ? `\n[Relevant Memories]:\n${memoryContext}` : ""}` },
                        { role: 'user', content: query }
                    ];
                    
                    let fallbackRes;
                    let fallbackRetries = 0;
                    while (fallbackRetries < MAX_API_RETRIES) {
                        try {
                            fallbackRes = await ollama.chat({ model, messages: fallbackMessages, stream: false });
                            break;
                        } catch (fbErr) {
                            fallbackRetries++;
                            console.warn(`[Orchestrator] Fallback API request failed (Attempt ${fallbackRetries}/${MAX_API_RETRIES}):`, fbErr.message);
                            if (fallbackRetries >= MAX_API_RETRIES) throw fbErr;
                            await new Promise(resolve => setTimeout(resolve, 3000));
                        }
                    }
                    return { thought: 'Planning timed out', context: fallbackRes.message.content };
                }
                
                apiRetries++;
                console.warn(`[Orchestrator] Planning API request failed (Attempt ${apiRetries}/${MAX_API_RETRIES}):`, err.message);
                if (apiRetries >= MAX_API_RETRIES) {
                    throw err; // throw error if all retries exhausted
                }
                await new Promise(resolve => setTimeout(resolve, 3000)); // wait 3 seconds before next retry
            }
        }

        let rawContent = response.message.content;
        let thought = "";
        let executionResults = [];

        // === ROBUST JSON EXTRACTION & REPAIR ENGINE ===

        /**
         * Extract the first complete JSON object using brace-counting.
         */
        const extractJsonFromText = (text) => {
            const start = text.indexOf('{');
            if (start === -1) return null;

            let depth = 0;
            let inString = false;
            let escapeNext = false;

            for (let i = start; i < text.length; i++) {
                const ch = text[i];
                if (escapeNext) { escapeNext = false; continue; }
                if (ch === '\\') { escapeNext = true; continue; }
                if (ch === '"') { inString = !inString; continue; }
                if (inString) continue;

                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) return text.substring(start, i + 1);
                }
            }
            // Incomplete JSON — return what we have for repair
            return text.substring(start);
        };

        /**
         * Comprehensive JSON repair for common LLM output quirks.
         */
        const repairJson = (jsonStr) => {
            let cleaned = jsonStr.trim();
            // Strip control characters
            cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            // Remove trailing commas
            cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
            // Fix single-quoted strings if pattern detected
            if (/\{\s*'/.test(cleaned) || /:\s*'/.test(cleaned)) {
                cleaned = cleaned.replace(/'([^']*?)'\s*:/g, '"$1":');
                cleaned = cleaned.replace(/:\s*'([^']*?)'/g, ': "$1"');
            }
            // Fix unquoted keys
            cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
            // Balance braces
            let ob = (cleaned.match(/\{/g) || []).length, cb = (cleaned.match(/\}/g) || []).length;
            while (ob > cb) { cleaned += '}'; cb++; }
            // Balance brackets
            let oB = (cleaned.match(/\[/g) || []).length, cB = (cleaned.match(/\]/g) || []).length;
            while (oB > cB) { cleaned += ']'; cB++; }
            return cleaned;
        };

        // 2. EXECUTION — Sanitize LLM output before parsing JSON
        rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
        rawContent = rawContent.replace(/<reasoning>[\s\S]*?<\/reasoning>\s*/gi, '');

        // Try to extract and parse JSON
        let plan = null;
        try {
            // Try markdown code block first
            const codeBlockMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
            let jsonCandidate;

            if (codeBlockMatch) {
                jsonCandidate = codeBlockMatch[1].trim();
            } else {
                jsonCandidate = extractJsonFromText(rawContent);
            }

            if (jsonCandidate) {
                plan = JSON.parse(repairJson(jsonCandidate));
            } else {
                throw new Error('No JSON found');
            }
        } catch (e) {
            // Fallback: try parsing the raw content directly
            try {
                plan = JSON.parse(repairJson(rawContent.trim()));
            } catch {
                console.warn("[Orchestrator] Non-JSON response. Treating as direct thought.");
                thought = rawContent.trim().substring(0, 500);
            }
        }

        if (plan) {
            thought = plan.thought || "";

            if (plan.selected_tools && plan.selected_tools.length > 0) {
                for (const toolCall of plan.selected_tools) {
                    const tool = tools.find(t => t.name === toolCall.name);
                    if (tool) {
                        // Inject chatId and image data
                        const toolEnv = { ...options, systemTime: timeString };
                        if (tool.name === 'vision_analyze' && options.imageBase64) {
                            toolCall.parameters.imageBase64 = options.imageBase64;
                        }

                        const result = await tool.execute(toolCall.parameters, toolEnv);
                        executionResults.push(`[Tool: ${tool.name}] Result: ${result}`);
                    }
                }
            }
        }

        // 3. FINAL RESPONSE
        const finalMessages = [
            { role: 'system', content: `${systemPromptText}\n\n${systemTimeContext}\n${memoryContext ? `\n[Relevant Memories]:\n${memoryContext}` : ""}` },
            { role: 'user', content: query }
        ];

        if (executionResults.length > 0) {
            finalMessages.push({ role: 'system', content: `Execution Context:\n${executionResults.join('\n\n')}` });
        }

        const finalRes = await ollama.chat({
            model: model,
            messages: finalMessages,
            stream: false
        });

        console.log(`[Orchestrator] Final Response Success (Model: ${model})`);

        return {
            thought: thought,
            context: finalRes.message.content
        };

    } catch (e) {
        console.error("[Backend Orchestrator] Error:", e);
        throw e;
    }
}

module.exports = { planAndExecuteBackend };
