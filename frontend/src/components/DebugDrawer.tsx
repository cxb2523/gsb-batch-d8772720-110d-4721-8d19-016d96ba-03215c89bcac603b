import { useState } from "react";
import { ChevronDown, ChevronRight, Terminal } from "lucide-react";
import LogTimeline from "./LogTimeline";
import { AgentEvent } from "../lib/api";

interface Props {
  jobId: string | null;
  events: AgentEvent[];
  isRunning: boolean;
}

/**
 * Agent activity panel. Inline in the main layout, sits right under the
 * job status card so sub-agent branches are visible without scrolling.
 * Auto-opens when a job is running; collapsible when the user is done with it.
 */
export default function DebugDrawer({ jobId, events, isRunning }: Props) {
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
  const open = isRunning && !manuallyCollapsed ? true : !manuallyCollapsed;
  // User explicitly toggled: flip manual collapse state
  const toggle = () => setManuallyCollapsed((v) => !v);

  if (!jobId) return null;

  return (
    <div className="rounded-xl border border-base-700 bg-base-900/60 overflow-hidden">
      <button
        onClick={toggle}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-slate-400 hover:text-slate-200 transition-colors text-left border-b border-base-800"
      >
        <Terminal size={14} />
        <span className="font-semibold uppercase tracking-wider text-xs">
          Agent activity
        </span>
        <span className="text-slate-600 font-mono text-xs">
          · {isRunning ? "live" : "final"} · {events.length} event
          {events.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto text-slate-600">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </button>
      {open && (
        <div className="max-h-[60vh] overflow-y-auto">
          <div className="p-4">
            {events.length === 0 ? (
              <div className="text-slate-500 text-sm">
                Waiting for the agent to produce events…
              </div>
            ) : (
              <LogTimeline events={events} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
