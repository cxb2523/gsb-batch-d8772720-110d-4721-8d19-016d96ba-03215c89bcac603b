import { SUBAGENT_PROMPTS } from './agentPrompts';
import { readBlackboard } from './blackboard';
import { config } from '../config';
import { getModelForRole } from '../router';

// Helper function to extract the first balanced JSON object from a string
const _extractJSON = (rawContent) => {
    if (!rawContent) return null;
    let content = rawContent.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
    
    // Priority 1: Markdown Block
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (jsonMatch) return jsonMatch[1];

    // Priority 2: Extract the first balanced brace that looks like an agent response
    // Using a more flexible check for keys (allows quotes or not, single or double)
    const agentKeyRegex = /['"]?(thought|tool|final_answer)['"]?\s*:/i;

    let firstBrace = content.indexOf('{');
    while (firstBrace !== -1) {
        let braceCount = 0;
        let inString = false;
        let escape = false;

        for (let i = firstBrace; i < content.length; i++) {
            const char = content[i];
            if (char === '"' && !escape) inString = !inString;
            if (!inString) {
                if (char === '{') braceCount++;
                if (char === '}') braceCount--;
                if (braceCount === 0) {
                    const candidate = content.substring(firstBrace, i + 1);
                    if (agentKeyRegex.test(candidate)) {
                        return candidate;
                    }
                    break;
                }
            }
            escape = (char === '\\' && !escape);
        }
        firstBrace = content.indexOf('{', firstBrace + 1);
    }

    return null;
};

// Helper to fix common LLM JSON errors (like unescaped newlines or ASCII art/tables)
const _fixMalformedJSON = (jsonStr) => {
    if (!jsonStr) return "";
    let fixed = jsonStr;
    
    // Fix 1: Remove common non-JSON garbage like ASCII tables or dividers that might follow/prefix JSON
    // These often start with +--- or | and break parsing
    fixed = fixed.replace(/^\+[+-]+\+[\r\n]*/gm, '');
    fixed = fixed.replace(/^\|[\s\S]*?\|[\r\n]*/gm, '');
    
    // Fix 2: Remove trailing commas before closing braces/brackets
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');
    
    // Fix 3: Escape unescaped newlines and control characters in string values
    fixed = fixed.replace(/(["[\w]+"]\s*:\s*")([\s\S]*?)("\s*[,}])/g, (match, prefix, content, suffix) => {
        const escapedContent = content
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
        return prefix + escapedContent + suffix;
    });

    // Fix 4: Handle "..." hallucinations
    fixed = fixed.replace(/:\s*\.\.\.\s*([,}])/g, ': null $1');
    
    return fixed;
};

// The core ReAct loop for a subagent
export const executeSubagentReActLoop = async (task, role, toolsArr, maxIterations = 5, onProgress = null, skillsText = '', recursionDepth = 0) => {
    // 🛡️ RECURSION GUARD: Stop infinite agent-spawning-agent loops
    const MAX_RECURSION = 1;
    let executableTools = [...toolsArr];

    // If we haven't reached max recursion, allow this agent to use the 'spawn' tool too
    if (recursionDepth < MAX_RECURSION) {
        const spawnTool = {
            name: 'spawn',
            description: 'Delegates a sub-task to a specialized agent (e.g. coder, researcher). Use THIS to fulfill "spawn a coder" requests.',
            execute: async (params, _ENV) => {
                // 💡 PARAMETER MAPPING: Fix common naming errors for sub-tasks
                const subTask = params.task || params.query || params.description || params.instruction || params.goal;
                const subRole = params.role || 'general';
                
                if (!subTask) {
                    console.warn(`[Subagent: ${role}] spawn called without a task. Defaulting to parent task.`);
                }

                return await executeSubagentReActLoop(
                    subTask || task, // Fallback to parent task if none provided
                    subRole, 
                    toolsArr, 
                    maxIterations, 
                    onProgress, 
                    skillsText, 
                    recursionDepth + 1
                );
            }
        };
        executableTools.push(spawnTool);
    }
    const cloudKey = config.getApiKey('VITE_OLLAMA_CLOUD_API_KEY');
    const host = import.meta.env.VITE_BACKEND_URL ? `${import.meta.env.VITE_BACKEND_URL}/cloud-api` : window.location.origin + '/cloud-api';
    
    // 🧠 MULTI-MODEL v2.0: Use centralized router for role-specific models
    const storedModel = getModelForRole(role);
    console.log(`[Subagent: ${role}] 🧠 Model selected: ${storedModel}`);

    const baseSystemPrompt = `You are a professional ${role} assistant.

### IMPORTANT: JSON RESPONSE MODE
YOUR RESPONSE MUST BE VALID JSON. 
DO NOT INCLUDE ANY TEXT OUTSIDE THE JSON OBJECT.

{
  "thought": "<your_reasoning_about_the_task>",
  "tool": "<tool_name_or_none>",
  "parameters": { "<param_name>": "<value>" },
  "is_complete": false,
  "final_answer": "<your_final_summary_if_done>"
}

### ROLE SPECIFIC INSTRUCTIONS
${SUBAGENT_PROMPTS[role] || SUBAGENT_PROMPTS.general}

### TOOLS
${executableTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

### CONTEXT
{{BLACKBOARD_CONTENT}}

### RULES
1. For complex research, ALWAYS use "deep_research" first.
2. For reading specific links, use "smart_browse".
3. Use "spawn" to delegate to other agents.
4. The Agentic Canvas is your UI for research. When you run deep_research, the user sees it there.
5. Use "update_blackboard" ONLY for long-term project memory or multi-agent coordination. Do not spam it for every step.

### RESPONSE FORMAT
YOUR ENTIRE RESPONSE MUST BE A SINGLE JSON OBJECT.
DO NOT INCLUDE TABLES, MARKDOWN DIVIDERS, OR CHATTER OUTSIDE THE JSON.
If you need to show data, put it in the "thought" or "final_answer" string.
`;

    const messages = [
        { role: 'system', content: baseSystemPrompt.replace('{{BLACKBOARD_CONTENT}}', "# Project Blackboard\nLoading...") }, 
        { role: 'user', content: role === 'coder' 
            ? `TASK: ${task || "Please proceed with the current objective."}

BEFORE writing any code, output a JSON with your "thought" containing a numbered plan of EXACTLY which files you will create (e.g., "1. index.html 2. style.css 3. script.js"). Then execute each step one by one using write_file.`
            : (task || "Please proceed with the current objective.")
        }
    ];

    // 📋 STEP TRACKER: Track completed actions for progress reminders
    let completedSteps = [];
    let filesWritten = [];

    let iterations = 0;
    let consecutiveJsonErrors = 0;
    while (iterations < maxIterations) {
        iterations++;

        // 🧠 CONTEXT MANAGEMENT
        if (messages.length > 20) {
            const systemPromptMsg = messages[0];
            const initialTask = messages[1];
            const recentHistory = messages.slice(-14);
            messages.splice(0, messages.length, systemPromptMsg, initialTask, ...recentHistory);
        }

        // 🦾 REFRESH CONTEXT: Inject dynamic blackboard content & specialized skills
        let currentBlackboard = "";
        try {
            currentBlackboard = await readBlackboard();
        } catch {
            currentBlackboard = "# Project Blackboard\nNo notes yet.";
        }
        
        const fullSystemPrompt = baseSystemPrompt
            .replace('{{BLACKBOARD_CONTENT}}', currentBlackboard || "# Project Blackboard\nNo notes yet.")
            + (skillsText ? `\n\n### SPECIALIZED SKILLS\n${skillsText}` : '');
        
        messages[0].content = fullSystemPrompt;

        // 🦾 NUCLEAR JSON ENFORCEMENT
        if (consecutiveJsonErrors > 0) {
            messages.push({ 
                role: 'user', 
                content: `CRITICAL ERROR: Your last response was not valid JSON. 
YOU MUST RESPOND WITH ONLY THE JSON OBJECT. 
FOLLOW THE STRUCTURE: { "thought": "...", "tool": "...", "parameters": {}, "is_complete": false, "final_answer": "" }` 
            });
        }

        let _retryCount = 0;
        const _maxRetries = 5;
        let _success = false;
        let _rawContent = '';

        while (_retryCount < _maxRetries && !_success) {
            try {
                const res = await fetch(`${host}/api/chat`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${cloudKey}`
                    },
                    body: JSON.stringify({
                        model: storedModel,
                        messages,
                        stream: true,
                        options: { reasoning_effort: 'medium', temperature: 0.1 }
                    })
                });

                if (!res.ok) {
                    const errText = await res.text();
                    throw new Error(`Cloud API Error (${res.status}): ${errText}`);
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let fullContent = '';
                let partialLine = '';
                let chunkCount = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    chunkCount++;
                    
                    if (chunkCount % 20 === 0) {
                        if (onProgress) onProgress(`Generating response... (${Math.floor(chunkCount/10)}kb)`);
                    }

                    if (chunk.includes('error code: 524')) {
                        throw new Error("Cloudflare Timeout (524) detected in stream.");
                    }

                    const lines = (partialLine + chunk).split('\n');
                    partialLine = lines.pop() || ''; 

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const json = JSON.parse(line);
                            if (json.error) throw new Error(`API Error: ${json.error.message || json.error}`);
                            
                            const msg = json.message || json;
                            fullContent += (msg.content || msg.reasoning_content || msg.thinking || msg.thinking_content || msg.thought || msg.response || "");
                        } catch {
                            if (line.includes('error')) throw new Error(`Proxy/API Error: ${line}`);
                        }
                    }
                }

                _rawContent = fullContent;
                if (!_rawContent?.trim()) throw new Error("Model returned an empty response.");
                _success = true;
            } catch (err) {
                _retryCount++;
                console.warn(`[Subagent: ${role}] attempt ${_retryCount} failed: ${err.message}`);
                if (_retryCount >= _maxRetries) throw err;
                await new Promise(r => setTimeout(r, 2000 * _retryCount));
                if (onProgress) onProgress(`\n> Warning: Connection unstable. Retrying... (${_retryCount}/${_maxRetries})`);
            }
        }

        messages.push({ role: 'assistant', content: _rawContent });

        // 🛠️ EXTRACTION & PARSING
        let action;
        try {
            const extracted = _extractJSON(_rawContent);
            try {
                action = JSON.parse(extracted);
            } catch {
                action = JSON.parse(_fixMalformedJSON(extracted));
            }
        } catch (e) {
            console.error(`[Subagent: ${role}] JSON Extraction failed: ${e.message}`);
        }

        console.log(`[Subagent: ${role}] Iteration ${iterations}:`, action ? (action.thought || 'thinking...') : 'extracting...');
        if (onProgress && action) onProgress(`\n> Thought (${iterations}/${maxIterations}): ${action.thought || '...'}`);

        if (!action) {
            consecutiveJsonErrors++;
            messages.pop(); // 💡 NUCLEAR: Remove the bad response from history
            console.error(`[Subagent: ${role}] JSON Parse Error ${consecutiveJsonErrors}/3. Deleted bad response.`);
            
            let retryMessage = `JSON Parse Error: Please output ONLY the raw JSON object. Use exactly the keys: thought, tool, parameters, is_complete, final_answer.`;
            
            if (consecutiveJsonErrors >= 3) {
                console.warn(`[Subagent: ${role}] NUKING HISTORY due to persistent loop.`);
                const systemPromptMsg = messages[0];
                const initialTask = messages[1];
                messages.splice(0, messages.length, systemPromptMsg, initialTask); // Hard reset
                
                retryMessage = `CRITICAL SYSTEM RESET: You have repeatedly failed to output valid JSON. 
STOP TALKING. STOP THINKING OUTSIDE THE JSON.
YOUR NEXT RESPONSE MUST BE ONLY THE JSON OBJECT.
{ "thought": "Resetting context and starting fresh to fix the JSON format.", "tool": "research", "parameters": { "query": "${task.substring(0, 40)}" }, "is_complete": false, "final_answer": "" }`;
                consecutiveJsonErrors = 0; 
            }
            
            messages.push({ role: 'user', content: retryMessage });
            continue;
        }

        consecutiveJsonErrors = 0; 

        if (action.is_complete || action.final_answer) {
            // 🛡️ PREMATURE COMPLETION GUARD: Coder agents MUST use write_file before finishing
            const hasWrittenFiles = messages.some(m => m.content && m.content.includes('[write_file] Result:'));
            const isCoderRole = role === 'coder';
            const tooEarly = iterations < 3;

            if (isCoderRole && !hasWrittenFiles && tooEarly) {
                console.warn(`[Subagent: ${role}] BLOCKED premature completion at iteration ${iterations}. No files written yet.`);
                messages.push({ role: 'user', content: `STOP. You declared completion but you have NOT written any files yet. Your task is to CREATE FILES using the 'write_file' tool. Do NOT put code in your thought or final_answer. Use write_file NOW.` });
                continue;
            }

            let finalOutput = action.final_answer;
            if (!finalOutput || finalOutput.length < 10) {
                // If the model finished but forgot to provide a detailed final_answer, fallback to its thoughts
                finalOutput = action.thought || "Task completed, but no final report was formatted.";
            }
            return finalOutput;
        }

        // 🛠️ TOOL EXECUTION with SELF-CORRECTION
        if (action.tool && action.tool !== 'none') {
            const toolName = action.tool.toLowerCase();
            const toolMatch = executableTools.find(t => t.name.toLowerCase() === toolName);

            // 💡 TOOL ALIASING (Self-Correction for common hallucinations)
            let finalTool = toolMatch;
            let finalParams = action.parameters || {};

            // 💡 SELF-CORRECTION: If model provides parameters directly as a string or wrong keys
            if (typeof finalParams === 'string') {
                finalParams = { query: finalParams };
            }

            if (!finalTool) {
                const aliasMap = {
                    'read_notes': 'read_blackboard',
                    'read_shared_notes': 'read_blackboard',
                    'request_notes': 'read_blackboard',
                    'shared_notes': 'read_blackboard',
                    'analysis': 'read_blackboard',
                    'write_notes': 'update_blackboard',
                    'research': 'deep_research',
                    'web_search': 'deep_research',
                    'google_search': 'deep_research',
                    'bing_search': 'deep_research',
                    'web_navigator': 'deep_research',
                    'browse': 'smart_browse'
                };
                const alias = aliasMap[toolName];
                if (alias) {
                    console.warn(`[Subagent: ${role}] Hallucination corrected: ${toolName} -> ${alias}`);
                    finalTool = executableTools.find(t => t.name === alias);
                }
            }

            // 💡 PARAMETER MAPPING (Fix common naming errors)
            if (finalTool && (finalTool.name === 'write_file' || finalTool.name === 'read_file')) {
                if (finalParams.path && !finalParams.targetPath) finalParams.targetPath = finalParams.path;
                if (finalParams.target_path && !finalParams.targetPath) finalParams.targetPath = finalParams.target_path;
                if (finalParams.file && !finalParams.targetPath) finalParams.targetPath = finalParams.file;
                if (finalParams.filename && !finalParams.targetPath) finalParams.targetPath = finalParams.filename;
                if (finalParams.dest && !finalParams.targetPath) finalParams.targetPath = finalParams.dest;
            }

            // 🛡️ WRITE_FILE CONTENT GUARD: Reject empty or placeholder writes
            if (finalTool && finalTool.name === 'write_file') {
                const contentToWrite = finalParams.content || '';
                if (contentToWrite.trim().length < 50) {
                    console.warn(`[Subagent: ${role}] BLOCKED empty/tiny write_file. Content length: ${contentToWrite.length}`);
                    messages.push({ role: 'user', content: `ERROR: write_file was called with empty or placeholder content (${contentToWrite.length} chars). You MUST provide the FULL file content. Write the complete HTML/CSS/JS code, not just a placeholder.` });
                    continue;
                }
            }

            if (finalTool && (finalTool.name === 'research')) {
                if (finalParams.task && !finalParams.query) finalParams.query = finalParams.task;
                if (finalParams.topic && !finalParams.query) finalParams.query = finalParams.topic;
                if (finalParams.description && !finalParams.query) finalParams.query = finalParams.description;
                if (finalParams.prompt && !finalParams.query) finalParams.query = finalParams.prompt;
                if (finalParams.search && !finalParams.query) finalParams.query = finalParams.search;
                if (finalParams.subject && !finalParams.query) finalParams.query = finalParams.subject;
                if (finalParams.content && !finalParams.query) finalParams.query = finalParams.content;
            }

            // 💡 CANVAS TOOL PARAMETER MAPPING
            if (finalTool && finalTool.name === 'canvas') {
                if (!finalParams.action && finalParams.type) finalParams.action = finalParams.type;
                if (!finalParams.action) finalParams.action = 'push';
            }

            if (finalTool) {
                console.log(`[Subagent: ${role}] 🚀 Executing tool: ${finalTool.name}`, finalParams);
                try {
                    const toolResult = await finalTool.execute(finalParams, { 
                        onProgress: (m) => onProgress && onProgress(`\n> Tool [${finalTool.name}]: ${m}`),
                        role: role
                    });
                    
                    // 📋 STEP TRACKER: Record completed steps
                    const stepSummary = `${finalTool.name}(${finalParams.targetPath || finalParams.query || finalParams.task || '...'})`.substring(0, 80);
                    completedSteps.push(stepSummary);
                    
                    if (finalTool.name === 'write_file' && finalParams.targetPath) {
                        filesWritten.push(finalParams.targetPath);
                    }

                    // 📋 PROGRESS REMINDER: Inject a summary so the model doesn't lose track
                    let progressReminder = '';
                    if (role === 'coder' && completedSteps.length > 0) {
                        progressReminder = `\n\n📋 PROGRESS UPDATE (Iteration ${iterations}/${maxIterations}):\n`;
                        progressReminder += `✅ Steps completed: ${completedSteps.length}\n`;
                        if (filesWritten.length > 0) {
                            progressReminder += `📁 Files written: ${filesWritten.join(', ')}\n`;
                        }
                        progressReminder += `⏳ Continue with the NEXT step in your plan. Do NOT repeat already-written files.`;
                    }

                    messages.push({ role: 'user', content: `Tool [${finalTool.name}] Result:\n${toolResult}${progressReminder}` });
                } catch (e) {
                    console.error(`[Subagent: ${role}] Tool [${finalTool.name}] Error:`, e.message);
                    messages.push({ role: 'user', content: `Tool [${finalTool.name}] Error: ${e.message}` });
                }
            } else {
                console.error(`[Subagent: ${role}] Tool not found: ${action.tool}`);
                messages.push({ role: 'user', content: `Tool [${action.tool}] not found. Please use only tools from the manifest.` });
            }
        } else {
            // Case where no tool is chosen. 
            // If the model says "I have gathered enough info" or similar in thought, nudge it to complete.
            const thought = (action.thought || "").toLowerCase();
            const completionKeywords = ['finished', 'complete', 'done', 'final report', 'summary', 'gathered everything', 'enough information'];
            const seemsDone = completionKeywords.some(k => thought.includes(k));

            if (seemsDone && !action.is_complete && !action.final_answer) {
                 messages.push({ role: 'user', content: "It seems you have enough information to finish. Please provide your 'final_answer' and set 'is_complete': true." });
            } else if (!action.is_complete) {
                messages.push({ role: 'user', content: `No tool was specified. If your task is not done, use one of: ${executableTools.map(t => t.name).join(', ')}.` });
            }
        }
    }

    return `Subagent reached maximum iterations (${maxIterations}) before completing the task.`;
};

export const createSubagentTool = (allTools, onTaskProgress) => {
    return {
        name: 'execute_subagent',
        description: 'AGENT TOOL: Spawn a synchronous subagent to autonomously complete a complex multi-step task. Roles: researcher, coder, executor, general.',
        parameters: { task: 'string', role: 'string (researcher|coder|executor|general)' },
        execute: async ({ task, role }, env) => {
            const reporter = (msg) => { if (onTaskProgress && env.taskId) onTaskProgress(env.taskId, msg); };
            return await executeSubagentReActLoop(task, role, allTools, 50, reporter, env.skillsText || '');
        }
    };
};
