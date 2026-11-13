import { executeSubagentReActLoop } from './subagentTool';

// The async spawn tool wrapper
export const createAsyncSpawnTool = (allTools, onMessageDirect, onTaskProgress) => {
    return {
        name: 'spawn',
        description: 'AGENT TOOL: Spawn an asynchronous, non-blocking background subagent for long-running tasks. This tool will return immediately, and the background agent will use the "message" tool to notify the user directly when the entire task is complete. Useful for slow tasks that should not block the main orchestrator.',
        runInBackground: true,
        // We simulate a task ID for the background agent to stream progress
        execute: async ({ task, role }, env) => {
            // Safety: Fallback if orchestrator failed to pass params
            const safeRole = role || 'general';
            const safeTask = task || env?.originalQuery || 'Complete the user request as described in the conversation.';
            
            console.log(`[Spawn] Starting background task (${safeRole}):`, safeTask);
            const reporter = (msg) => { if (onTaskProgress && env.taskId) onTaskProgress(env.taskId, msg); };

            const maxIterations = parseInt(import.meta.env.VITE_SUBAGENT_MAX_ITERATIONS) || 15;
            return executeSubagentReActLoop(safeTask, safeRole, allTools, maxIterations, reporter, env.skillsText || '')
                .then(result => {
                    // Result handling is now exclusively in App.jsx's handleTaskComplete
                    // 🛡️ AUTO-BLACKBOARD SYNC: Force the blackboard to update since smaller models skip the instruction.
                    import('./blackboard').then(({ updateBlackboard }) => {
                        updateBlackboard(safeRole, `### Background Task Result: ${safeTask}\n\n${result}`)
                            .catch(err => console.error("[Spawn] Auto-Blackboard sync failed:", err));
                    });
                    
                    // 🔥 NUCLEAR UI BYPASS: Ensure report is sent directly to the chat, bypassing any React state batching anomalies
                    if (onMessageDirect && result && result.trim().length > 20) {
                        // Unescape literal \n characters properly so ReactMarkdown renders lists and paragraphs instead of a flat string
                        // Also force inline bullets (•) to newlines as smaller models often strip newlines in JSON
                        let formattedResult = result.replace(/\\n/g, '\n');
                        formattedResult = formattedResult.replace(/•\s/g, '\n- ');
                        
                        onMessageDirect(`🕵️ **Background Task Complete:**\n\n${formattedResult}`, 'assistant');
                    } else if (onMessageDirect && (!result || result.trim().length <= 20)) {
                        console.warn(`[Spawn] Result too short or empty (${result?.length || 0} chars). Suppressing empty notification.`);
                    }
                    
                    return result;
                })
                .catch(e => {
                    if (onTaskProgress && env.taskId) onTaskProgress(env.taskId, `\n> Fatal Error: ${e.message}`);
                    throw e; 
                });
        }
    };
};
