import React from 'react';
import { Activity, CheckCircle, XCircle, Loader2, Cpu, Ban, Terminal, Circle } from 'lucide-react';

const STATUS_CONFIG = {
    running: { color: '#00f3ff', bg: 'var(--color-accent-blue)', border: 'var(--color-accent-blue)', label: 'RUNNING', dot: 'animate-pulse' },
    completed: { color: '#00ff88', bg: 'rgba(0,255,136,0.05)', border: 'rgba(0,255,136,0.20)', label: 'DONE', dot: '' },
    failed: { color: '#ff003c', bg: 'rgba(var(--rgb-accent-red), 0.06)', border: 'rgba(var(--rgb-accent-red), 0.25)', label: 'FAILED', dot: '' },
    cancelled: { color: '#555', bg: 'rgba(255,255,255,0.02)', border: 'rgba(255,255,255,0.06)', label: 'KILLED', dot: '' },
};

const TaskControl = ({ tasks, onCancelTask }) => {
    const running = tasks.filter(t => t.status === 'running');

    return (
        <div className="w-full animate-in fade-in duration-300">

            {/* Panel Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-200">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-accent-blue/10 flex items-center justify-center">
                        <Terminal size={16} className="text-accent-blue" />
                    </div>
                    <div>
                        <h2 className="text-xs font-bold font-mono text-accent-blue uppercase tracking-[0.2em]">Process Monitor</h2>
                        <p className="text-[10px] text-gray-600 font-mono">Active background agents</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {running.length > 0 && (
                        <span className="flex items-center gap-1.5 text-[10px] font-bold font-mono text-accent-blue bg-accent-blue/10 border border-accent-blue/20 px-2 py-0.5 rounded-full">
                            <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse inline-block" />
                            {running.length} ACTIVE
                        </span>
                    )}
                </div>
            </div>

            {/* Process List */}
            <div className="p-4 space-y-2">
                {tasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 opacity-20">
                        <Cpu size={32} className="mb-3 text-gray-500" />
                        <p className="font-mono text-[10px] tracking-[0.3em] text-gray-500 uppercase">No Active Processes</p>
                    </div>
                ) : (
                    [...tasks].reverse().map(task => {
                        const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.completed;
                        return (
                            <div
                                key={task.id}
                                className="group relative rounded-xl border overflow-hidden transition-all duration-300"
                                style={{ background: cfg.bg, borderColor: cfg.border }}
                            >
                                {/* Left accent bar */}
                                <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: cfg.color, boxShadow: `0 0 8px ${cfg.color}` }} />

                                <div className="flex items-center justify-between px-4 py-3 ml-1">
                                    <div className="flex items-center gap-3 min-w-0">
                                        {/* Status icon */}
                                        <div className="shrink-0">
                                            {task.status === 'running' && <Loader2 size={16} className="animate-spin" style={{ color: cfg.color }} />}
                                            {task.status === 'completed' && <CheckCircle size={16} style={{ color: cfg.color }} />}
                                            {task.status === 'failed' && <XCircle size={16} style={{ color: cfg.color }} />}
                                            {task.status === 'cancelled' && <Ban size={16} style={{ color: cfg.color }} />}
                                        </div>

                                        <div className="min-w-0">
                                            <h3 className="text-sm font-semibold text-gray-100 truncate font-mono capitalize">
                                                {task.name.replace(/_/g, ' ')}
                                            </h3>
                                            <p className="text-[10px] font-mono mt-0.5 truncate" style={{ color: cfg.color + 'aa' }}>
                                                {task.progress || (task.status === 'running' ? 'Executing...' : task.status)}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2 shrink-0 ml-2">
                                        <span
                                            className="text-[9px] font-bold font-mono tracking-[0.15em] px-2 py-0.5 rounded-full border"
                                            style={{ color: cfg.color, borderColor: cfg.border, background: cfg.bg }}
                                        >
                                            {cfg.label}
                                        </span>
                                        {task.status === 'running' && onCancelTask && (
                                            <button
                                                onClick={() => onCancelTask(task.id)}
                                                title="Kill Process"
                                                className="w-6 h-6 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:bg-red-500/20 text-gray-500 hover:text-red-400"
                                            >
                                                <XCircle size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* Execution Logs (only show if there are logs) */}
                                {task.logs && task.logs.length > 0 && (
                                    <div className="bg-gray-200 border-t border-gray-200 p-3 font-mono text-[9px] text-gray-600 max-h-32 overflow-y-auto custom-scrollbar">
                                        <div className="space-y-1">
                                            {task.logs.map((log, i) => (
                                                <div key={i} className={`whitespace-pre-wrap ${log.includes('Error') || log.includes('Failed') ? 'text-red-400' : log.includes('Result:') || log.includes('Complete') ? 'text-[#00ff88]' : 'text-gray-500'}`}>
                                                    {log}
                                                </div>
                                            ))}
                                            {/* Auto-scroll anchor */}
                                            {task.status === 'running' && (
                                                <div ref={(el) => { if (el) el.scrollIntoView({ behavior: 'smooth' }) }} />
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

export default TaskControl;
