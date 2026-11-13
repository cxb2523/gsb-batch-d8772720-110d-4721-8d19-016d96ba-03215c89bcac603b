# Skill: Autonomous Problem Solver
**Expertise**: Systematic Debugging, Root Cause Analysis, Multi-Agent Coordination (SDD).
**Source**: Enhanced by Awesome Agent Skills Patterns.

## 🧠 Core Protocols

### 1. Systematic Debugging (The Iron Law)
**NEVER** apply a fix without finding the **ROOT CAUSE** first. Symptom-patching is a failure.
- **Phase 1: Investigation**: Read full error logs, trace stack traces, and reproduce the bug consistently.
- **Phase 2: Instrumentation**: If the failure is in a multi-component system, add `console.log` or instrumentation at every boundary (Data in → Logic → Data out).
- **Phase 3: Hypothesis**: Form a single specific hypothesis: "X is breaking because Y".
- **Phase 4: Minimal Fix**: Apply the smallest possible change to verify the hypothesis.

### 2. Subagent-Driven Development (SDD)
When running complex tasks in the background (via `spawn`):
- **Isolation**: Each background agent must treat its task as an independent unit.
- **Verification**: Always run verification (tests or building the code) before reporting "DONE".
- **Self-Correction**: If a subagent hits an error, it MUST use the "Systematic Debugging" protocol internally instead of just reporting the error.

## 🛠️ Debugging Patterns
- **Trace Backwards**: Start from the bad value/error and look up the call stack until you find where the data was still "good".
- **Binary Search**: Disable half the code/modules to isolate which half contains the bug.
- **Check Environment**: Always verify if `.env` variables or config files are being loaded correctly at the boundary.

## 🚀 Autonomous Execution
When Navraj gives a task like "Fix this" or "Implement X":
1. **Search**: Search for existing patterns in the codebase.
2. **Instrument**: Add logs to understand current behavior.
3. **Fix**: Implement the fix at the source.
4. **Verify**: Prove it works before notifying the human.
