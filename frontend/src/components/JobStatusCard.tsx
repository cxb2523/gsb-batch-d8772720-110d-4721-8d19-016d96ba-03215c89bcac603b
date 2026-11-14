import { Clock, Loader2, Square, XCircle, CheckCircle2, AlertTriangle } from "lucide-react";
import { AgentEvent, JobStatus, JobTerminalStatus } from "../lib/api";

interface Props {
  query: string;
  jobId: string;
  events: AgentEvent[];
  finalStatus: JobTerminalStatus | null;
  jobSnapshot: { status: JobStatus; error: string | null; duration_sec: number | null } | null;
  onCancel: () => void;
}

function formatElapsed(sec: number | null | undefined): string {
  if (sec == null) return "–";
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${s}s`;
}

function latestDescription(events: AgentEvent[]): string {
  // Walk backwards for the most user-meaningful event.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const p = ev.payload as Record<string, unknown>;
    if (ev.type === "tool_call") {
      const title = String(p.title ?? "tool");
      const ri = p.raw_input as Record<string, unknown> | undefined;
      let subject = "";
      if (ri) {
        if (typeof ri.query === "string") subject = `"${ri.query}"`;
        else if (typeof ri.url === "string") subject = ri.url as string;
        else if (typeof ri.command === "string") subject = String(ri.command);
      }
      return `${title}${subject ? ` · ${subject}` : ""}`;
    }
    if (ev.type === "message") {
      return `reply: ${String(p.text ?? "").slice(0, 80)}`;
    }
    if (ev.type === "thought") {
      return `thinking…`;
    }
    if (ev.type === "spawn") {
      return "spawned agent…";
    }
  }
  return "waiting for first event…";
}

function elapsedFromEvents(events: AgentEvent[], final: JobTerminalStatus | null): number | null {
  if (events.length === 0) return null;
  const first = new Date(events[0].ts).getTime();
  if (final?.duration_sec != null) return final.duration_sec;
  const now = Date.now();
  return (now - first) / 1000;
}

export default function JobStatusCard({
  query,
  jobId,
  events,
  finalStatus,
  jobSnapshot,
  onCancel,
}: Props) {
  const status: JobStatus = finalStatus?.status
    ?? jobSnapshot?.status
    ?? (events.length === 0 ? "queued" : "running");
  const isRunning = status === "running" || status === "queued";
  const isDone = status === "completed";
  const isErrored = status === "failed" || status === "timeout" || status === "cancelled";

  const elapsed = finalStatus?.duration_sec ?? jobSnapshot?.duration_sec
    ?? elapsedFromEvents(events, finalStatus);
  const error = finalStatus?.error ?? jobSnapshot?.error ?? null;
  const subtitle = isRunning ? latestDescription(events) : null;

  return (
    <div className="rounded-xl border border-base-700 bg-base-800/60 overflow-hidden">
      <div className="px-5 py-4 border-b border-base-700 flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Research query</div>
          <div className="text-slate-100 font-medium line-clamp-2">{query}</div>
          <div className="text-xs text-slate-500 mt-1 font-mono">job: {jobId}</div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5 text-slate-400 text-sm">
            <Clock size={14} />
            <span className="font-mono">{formatElapsed(elapsed)}</span>
          </div>
          {isRunning && (
            <button
              onClick={onCancel}
              className="flex items-center gap-1.5 rounded-md bg-red-500/10 hover:bg-red-500/20
                         border border-red-500/30 text-red-400 hover:text-red-300
                         px-3 py-1.5 text-sm font-medium transition-colors"
              aria-label="Stop"
              title="Stop and kill the running agent"
            >
              <Square size={12} className="fill-current" />
              <span>Stop</span>
            </button>
          )}
        </div>
      </div>

      <div className="px-5 py-4 flex items-center gap-3 text-sm">
        {isRunning && (
          <>
            <Loader2 size={14} className="animate-spin text-accent-400 shrink-0" />
            <div className="text-slate-300 font-mono text-xs truncate">
              {subtitle}
            </div>
            <div className="ml-auto text-xs text-slate-500 font-mono shrink-0">
              {events.length} event{events.length === 1 ? "" : "s"}
            </div>
          </>
        )}
        {isDone && (
          <div className="flex items-center gap-2 text-emerald-400">
            <CheckCircle2 size={14} />
            <span className="text-sm">
              Completed in <span className="font-mono">{(elapsed ?? 0).toFixed(1)}s</span>
            </span>
          </div>
        )}
        {isErrored && (
          <div className="flex items-center gap-2 text-red-400">
            {status === "cancelled" ? <XCircle size={14} /> : <AlertTriangle size={14} />}
            <span className="text-sm font-semibold capitalize">{status}</span>
          </div>
        )}
      </div>

      {isErrored && error && (
        <div className="px-5 py-3 border-t border-red-900/30 bg-red-950/20 text-red-300/80 font-mono text-xs break-all">
          {error}
        </div>
      )}
    </div>
  );
}
