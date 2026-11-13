import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import {
    X, Maximize2, Minimize2, Zap, Layout, ChevronRight, Activity, Cpu,
    Copy, Pin, PinOff, Trash2, Expand, MessageSquare, Search, Filter,
    CheckCheck, RotateCcw, GripVertical, FileText, BarChart3, Code2,
    Youtube, Map as MapIcon, Eye, Layers
} from 'lucide-react';
import { io } from 'socket.io-client';
import DiffViewer from './DiffViewer';
import ChartRenderer from './ChartRenderer';
import YouTubePlayer from './YouTubePlayer';
import JarvisHUD from './JarvisHUD';
import MapRenderer from './MapRenderer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

// Block type config for badges & filtering
const BLOCK_TYPES = {
    text: { icon: FileText, label: 'Text', color: 'cyan' },
    markdown: { icon: Code2, label: 'Markdown', color: 'purple' },
    metric: { icon: BarChart3, label: 'Metric', color: 'emerald' },
    chart: { icon: BarChart3, label: 'Chart', color: 'amber' },
    preview: { icon: Eye, label: 'Preview', color: 'blue' },
    diff: { icon: Code2, label: 'Diff', color: 'orange' },
    youtube: { icon: Youtube, label: 'YouTube', color: 'red' },
    map: { icon: MapIcon, label: 'Map', color: 'green' },
};

// Tooltip wrapper
const Tip = ({ text, children }) => (
    <div className="relative group/tip">
        {children}
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-white border border-gray-200 rounded-md text-[9px] text-gray-900 font-bold whitespace-nowrap opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-50">
            {text}
        </div>
    </div>
);

// Action button
const ActionBtn = ({ icon: Icon, onClick, label, variant = 'default' }) => {
    const colors = {
        default: 'text-gray-900  hover:text-cyan-400 hover:bg-cyan-500/10',
        danger: 'text-gray-900  hover:text-red-400 hover:bg-red-500/10',
        success: 'text-gray-900  hover:text-emerald-400 hover:bg-emerald-500/10',
        pin: 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10',
    };
    return (
        <Tip text={label}>
            <button onClick={onClick} className={`p-1.5 rounded-lg transition-all ${colors[variant]}`}>
                <Icon size={13} />
            </button>
        </Tip>
    );
};

// Block type badge
const TypeBadge = ({ type }) => {
    const cfg = BLOCK_TYPES[type] || BLOCK_TYPES.text;
    const Icon = cfg.icon;
    const colorMap = {
        cyan: 'text-cyan-400 bg-cyan-500/10', purple: 'text-purple-400 bg-purple-500/10',
        emerald: 'text-emerald-400 bg-emerald-500/10', amber: 'text-amber-400 bg-amber-500/10',
        blue: 'text-blue-400 bg-blue-500/10', orange: 'text-orange-400 bg-orange-500/10',
        red: 'text-red-400 bg-red-500/10', green: 'text-green-400 bg-green-500/10',
    };
    return (
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider ${colorMap[cfg.color]}`}>
            <Icon size={9} /> {cfg.label}
        </span>
    );
};

// Empty state (Holographic Sci-Fi HUD Empty State)
const EmptyCanvas = () => (
    <div className="h-full flex flex-col items-center justify-center text-center space-y-6 pt-12 select-none px-4">
        <div className="relative w-28 h-28 flex items-center justify-center">
            {/* Pulsing glow background */}
            <div className="absolute inset-0 bg-cyan-500/5 rounded-full filter blur-xl animate-pulse" />

            {/* Custom SVG Jarvis concentric HUD */}
            <svg className="w-full h-full absolute animate-[spin_20s_linear_infinite]" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="44" stroke="rgba(0, 243, 255, 0.08)" strokeWidth="1" fill="none" />
                <circle cx="50" cy="50" r="38" stroke="rgba(0, 243, 255, 0.2)" strokeWidth="1.5" strokeDasharray="5, 10" fill="none" />
                <circle cx="50" cy="50" r="32" stroke="rgba(0, 243, 255, 0.15)" strokeWidth="1.5" strokeDasharray="30, 20" fill="none" />
            </svg>
            <svg className="w-4/5 h-4/5 absolute animate-[spin_8s_linear_infinite_reverse]" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="28" stroke="rgba(168, 85, 247, 0.25)" strokeWidth="2" strokeDasharray="10, 4" fill="none" />
                <circle cx="50" cy="50" r="22" stroke="rgba(0, 243, 255, 0.3)" strokeWidth="1.5" strokeDasharray="4, 12" fill="none" />
            </svg>

            {/* Center target orb */}
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center shadow-[0_0_15px_rgba(6,182,212,0.8)] border border-cyan-300/40 z-10">
                <div className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
            </div>
        </div>

        <div className="space-y-2">
            <p className="text-[11px] text-gray-900 max-w-[240px] mx-auto leading-relaxed font-bold">
                Mainframe synchronized. Awaiting instruction. Ask Liya to display visuals, code, or deep research.
            </p>
        </div>

        <div className="flex gap-2 justify-center opacity-40 scale-90">
            {['chart', 'map', 'preview', 'diff'].map(t => <TypeBadge key={t} type={t} />)}
        </div>
    </div>
);

const Canvas = ({ isVisible, onClose }) => {
    const [state, setState] = useState({ blocks: [], isVisible: false });
    const [isExpanded, setIsExpanded] = useState(false);
    const [isOffline, setIsOffline] = useState(false);
    const [mode, setMode] = useState('feed');
    const [searchQuery, setSearchQuery] = useState('');
    const [typeFilter, setTypeFilter] = useState('all');
    const [copiedId, setCopiedId] = useState(null);
    const [expandedBlockId, setExpandedBlockId] = useState(null);
    const [showSearch, setShowSearch] = useState(false);

    useEffect(() => {
        const s = io(BACKEND_URL);
        s.on('connect', () => setIsOffline(false));
        s.on('disconnect', () => setIsOffline(true));
        s.on('canvas-update', (newState) => {
            setState(newState);
            if (newState.mode) setMode(newState.mode);
        });
        fetch(`${BACKEND_URL}/api/canvas/state`)
            .then(res => res.json())
            .then(data => setState(data))
            .catch(err => console.error("Canvas Fetch Error:", err));
        return () => s.disconnect();
    }, []);

    // Keyboard: Escape to close
    useEffect(() => {
        const handler = (e) => { if (e.key === 'Escape' && isVisible) onClose?.(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isVisible, onClose]);

    const handleMinimize = () => {
        onClose?.();
        fetch(`${BACKEND_URL}/api/canvas/visibility`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visible: false })
        });
    };

    const handleClose = () => {
        onClose?.();
        fetch(`${BACKEND_URL}/api/canvas/reset`, { method: 'POST' });
        fetch(`${BACKEND_URL}/api/canvas/visibility`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visible: false })
        });
    };

    // --- Interactive Actions ---
    const handleCopy = useCallback((block) => {
        const text = block.content || block.value || block.label || '';
        navigator.clipboard.writeText(text).then(() => {
            setCopiedId(block.id);
            setTimeout(() => setCopiedId(null), 2000);
        });
    }, []);

    const handleDelete = useCallback((blockId) => {
        // Optimistic UI removal
        setState(prev => ({ ...prev, blocks: prev.blocks.filter(b => b.id !== blockId) }));
        fetch(`${BACKEND_URL}/api/canvas/block/${blockId}`, { method: 'DELETE' });
    }, []);

    const handlePin = useCallback((blockId) => {
        setState(prev => ({
            ...prev,
            blocks: prev.blocks.map(b => b.id === blockId ? { ...b, pinned: !b.pinned, pinnedAt: !b.pinned ? Date.now() : null } : b)
        }));
        fetch(`${BACKEND_URL}/api/canvas/block/${blockId}/pin`, { method: 'POST' });
    }, []);

    const handleShareToChat = useCallback((block) => {
        const text = block.content || block.value || JSON.stringify(block);
        window.dispatchEvent(new CustomEvent('canvas-auto-submit', { detail: `[From Canvas] ${text}` }));
    }, []);

    const handleClearAll = useCallback(() => {
        setState(prev => ({ ...prev, blocks: [] }));
        fetch(`${BACKEND_URL}/api/canvas/reset`, { method: 'POST' });
    }, []);

    // --- Filtering & Sorting ---
    const processedBlocks = useMemo(() => {
        let blocks = [...(state.blocks || [])];
        // Search filter
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            blocks = blocks.filter(b =>
                (b.content || '').toLowerCase().includes(q) ||
                (b.label || '').toLowerCase().includes(q) ||
                (b.type || '').toLowerCase().includes(q)
            );
        }
        // Type filter
        if (typeFilter !== 'all') {
            blocks = blocks.filter(b => b.type === typeFilter);
        }
        // Sort: pinned first
        blocks.sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return 0;
        });
        return blocks;
    }, [state.blocks, searchQuery, typeFilter]);

    const blockTypes = useMemo(() => {
        const types = new Set((state.blocks || []).map(b => b.type));
        return ['all', ...types];
    }, [state.blocks]);

    const finalVisibility = isVisible || state.isVisible;
    const blockCount = (state.blocks || []).length;
    const pinnedCount = (state.blocks || []).filter(b => b.pinned).length;

    // --- Block Content Renderer ---
    const renderBlockContent = (block) => {
        switch (block.type) {
            case 'text':
                return (
                    <div className="space-y-1">
                        {block.label && <span className="text-[10px] uppercase tracking-wider text-cyan-400 font-bold opacity-80">{block.label}</span>}
                        <p className="text-sm text-gray-900 leading-relaxed font-medium">{block.content}</p>
                    </div>
                );
            case 'markdown':
                return (
                    <div className="space-y-2">
                        {block.label && <span className="text-[10px] uppercase tracking-wider text-purple-400 font-bold opacity-80">{block.label}</span>}
                        <div className="prose prose-sm prose-slate max-w-none text-gray-900 leading-relaxed">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
                        </div>
                    </div>
                );
            case 'metric':
                return (
                    <div className="flex items-center justify-between font-bold">
                        <div>
                            <p className="text-[10px] uppercase text-gray-900 mb-1">{block.label}</p>
                            <p className="text-2xl text-gray-900">{block.value}</p>
                        </div>
                        {block.trend && (
                            <span className={`text-[10px] px-2 py-1 rounded-full ${block.trend > 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                {block.trend > 0 ? '+' : ''}{block.trend}%
                            </span>
                        )}
                    </div>
                );
            case 'chart':
                return (
                    <div className="w-full" style={{ minHeight: '280px', height: '300px' }}>
                        <ChartRenderer type={block.chartType} data={block.data} title={block.label} />
                    </div>
                );
            case 'preview':
                return (
                    <div className="w-full bg-white rounded-lg overflow-hidden" style={{ height: '400px' }}>
                        <iframe srcDoc={block.content} className="w-full h-full border-none" sandbox="allow-scripts allow-same-origin allow-modals" />
                    </div>
                );
            case 'diff':
                return <DiffViewer oldCode={block.oldCode} newCode={block.newCode} fileName={block.fileName} splitView={isExpanded} />;
            case 'youtube':
                return <YouTubePlayer block={block} />;
            case 'map':
                return <MapRenderer block={block} />;
            default:
                return <p className="text-sm text-gray-900">{block.content || JSON.stringify(block)}</p>;
        }
    };

    return (
        <motion.div
            initial={false}
            animate={{ x: finalVisibility ? 0 : 500, opacity: finalVisibility ? 1 : 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            style={{ pointerEvents: finalVisibility ? 'auto' : 'none' }}
            className={`fixed right-0 top-0 h-full bg-white/95 backdrop-blur-2xl border-l border-gray-200 z-[999] shadow-[0_0_60px_rgba(0,0,0,0.1)] flex flex-col ${isExpanded ? 'w-[80vw]' : 'w-[420px]'}`}
        >
            {/* ═══ HEADER ═══ */}
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-gray-50 to-transparent">
                <div className="flex items-center gap-2.5">
                    <div className="p-2 bg-gradient-to-br from-cyan-500/20 to-blue-500/10 rounded-xl relative overflow-hidden">
                        <Layout size={16} className="text-cyan-400 relative z-10" />
                        <div className="absolute inset-0 bg-cyan-500/10 animate-pulse" />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-[13px] font-black text-gray-900 tracking-tight uppercase">Agentic Canvas</h2>
                            {blockCount > 0 && (
                                <span className="px-1.5 py-0.5 bg-cyan-500/10 text-cyan-400 text-[9px] font-black rounded-md">{blockCount}</span>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5 font-mono">
                            <span className={`flex h-1.5 w-1.5 rounded-full animate-pulse ${isOffline ? 'bg-red-500' : 'bg-emerald-500'}`} />
                            <span className="text-[9px] text-gray-900 font-bold tracking-tighter uppercase">{isOffline ? 'OFFLINE' : 'LIVE SYNC'}</span>
                            {pinnedCount > 0 && <span className="text-[9px] text-amber-400/60 font-bold ml-1">• {pinnedCount} pinned</span>}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-0.5">
                    {blockCount > 0 && (
                        <>
                            <Tip text="Search">
                                <button onClick={() => setShowSearch(!showSearch)} className={`p-2 rounded-lg transition-all ${showSearch ? 'bg-cyan-500/10 text-cyan-400' : 'text-gray-900  hover:text-gray-900  hover:bg-gray-100 '}`}>
                                    <Search size={14} />
                                </button>
                            </Tip>
                            <Tip text="Clear All">
                                <button onClick={handleClearAll} className="p-2 hover:bg-red-500/10 rounded-lg text-gray-900 hover:text-red-400 transition-all">
                                    <RotateCcw size={14} />
                                </button>
                            </Tip>
                        </>
                    )}
                    <button onClick={() => setIsExpanded(!isExpanded)} className="p-2 hover:bg-gray-100 rounded-lg text-gray-900 hover:text-gray-900 transition-all">
                        {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                    <button onClick={handleMinimize} className="p-2 hover:bg-gray-100 rounded-lg text-gray-900 hover:text-cyan-400 transition-all">
                        <ChevronRight size={16} />
                    </button>
                    <button onClick={handleClose} className="p-2 hover:bg-red-500/10 rounded-lg text-gray-900 hover:text-red-500 transition-all">
                        <X size={16} />
                    </button>
                </div>
            </div>

            {/* ═══ SEARCH & FILTER BAR ═══ */}
            <AnimatePresence>
                {showSearch && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden border-b border-gray-200"
                    >
                        <div className="px-4 py-3 space-y-2 bg-white/[0.01]">
                            <div className="relative">
                                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-900" />
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Search blocks..."
                                    className="w-full bg-gray-50 border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-accent-blue/30 font-mono"
                                    autoFocus
                                />
                            </div>
                            <div className="flex gap-1.5 flex-wrap">
                                {blockTypes.map(t => (
                                    <button
                                        key={t}
                                        onClick={() => setTypeFilter(t)}
                                        className={`px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-wider transition-all ${typeFilter === t ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/30' : 'bg-gray-100  text-gray-600  border border-transparent hover:text-gray-900 '}`}
                                    >
                                        {t}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ═══ TAB SWITCHER ═══ */}
            <div className="flex px-4 py-2 border-b border-gray-200 bg-gray-50 gap-5">
                <button onClick={() => setMode('feed')}
                    className={`flex items-center gap-2 pb-2 transition-all relative ${mode === 'feed' ? 'text-cyan-400' : 'text-gray-900  hover:text-gray-900 '}`}>
                    <Activity size={13} />
                    <span className="text-[10px] font-black uppercase tracking-wider">Feed</span>
                    {mode === 'feed' && <motion.div layoutId="canvas-tab" className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full shadow-[0_0_10px_rgba(34,211,238,0.6)]" />}
                </button>
                <button onClick={() => setMode('dashboard')}
                    className={`flex items-center gap-2 pb-2 transition-all relative ${mode === 'dashboard' ? 'text-purple-400' : 'text-gray-900  hover:text-gray-900 '}`}>
                    <Cpu size={13} />
                    <span className="text-[10px] font-black uppercase tracking-wider">Dashboard</span>
                    {mode === 'dashboard' && <motion.div layoutId="canvas-tab" className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-purple-500 to-pink-500 rounded-full shadow-[0_0_10px_rgba(168,85,247,0.6)]" />}
                </button>
            </div>

            {/* ═══ CONTENT AREA ═══ */}
            <div className="flex-1 overflow-y-auto px-3 py-3 custom-scrollbar">
                <div className={mode === 'dashboard' ? 'block' : 'hidden'}>
                    <JarvisHUD
                        aiState={state.blocks.length > 0 ? (state.blocks[0].type === 'chart' ? 'executing' : 'thinking') : 'idle'}
                        activeTools={state.blocks}
                    />
                </div>

                <div className={mode === 'feed' ? 'space-y-3' : 'h-0 overflow-hidden opacity-0 pointer-events-none'}>
                    {processedBlocks.length === 0 && !searchQuery && typeFilter === 'all' ? (
                        <EmptyCanvas />
                    ) : processedBlocks.length === 0 ? (
                        <div className="text-center py-12 opacity-40">
                            <Search size={28} className="mx-auto mb-3 text-gray-900" />
                            <p className="text-xs text-gray-900">No blocks match your filter</p>
                        </div>
                    ) : (
                        <AnimatePresence mode="popLayout">
                            {processedBlocks.map((block, idx) => {
                                const blockId = block.id || `block-${idx}`;
                                const isPinned = block.pinned;
                                return (
                                    <motion.div
                                        key={blockId}
                                        layout
                                        initial={{ y: 20, opacity: 0, scale: 0.97 }}
                                        animate={{ y: 0, opacity: 1, scale: 1 }}
                                        exit={{ x: 300, opacity: 0, scale: 0.9 }}
                                        transition={{ type: 'spring', damping: 25, stiffness: 300, delay: idx * 0.03 }}
                                        className={`group relative rounded-xl border transition-all duration-200 ${isPinned
                                            ? 'bg-amber-500/[0.03] border-amber-500/20 shadow-[0_0_20px_rgba(245,158,11,0.05)]'
                                            : 'bg-gray-50  border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.04]'
                                            } ${expandedBlockId === blockId ? 'col-span-full' : ''}`}
                                    >
                                        {/* Pin indicator */}
                                        {isPinned && (
                                            <div className="absolute -top-px left-4 right-4 h-[2px] bg-gradient-to-r from-transparent via-amber-500/40 to-transparent rounded-full" />
                                        )}

                                        {/* Block header — type badge + actions */}
                                        <div className="flex items-center justify-between px-3.5 pt-3 pb-1">
                                            <div className="flex items-center gap-2">
                                                <TypeBadge type={block.type} />
                                                {isPinned && <Pin size={10} className="text-amber-400" />}
                                            </div>
                                            {/* Actions — visible on hover */}
                                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                                                <ActionBtn icon={copiedId === blockId ? CheckCheck : Copy} onClick={() => handleCopy(block)} label="Copy" variant={copiedId === blockId ? 'success' : 'default'} />
                                                <ActionBtn icon={isPinned ? PinOff : Pin} onClick={() => handlePin(blockId)} label={isPinned ? 'Unpin' : 'Pin'} variant={isPinned ? 'pin' : 'default'} />
                                                <ActionBtn icon={Expand} onClick={() => setExpandedBlockId(expandedBlockId === blockId ? null : blockId)} label="Expand" />
                                                <ActionBtn icon={MessageSquare} onClick={() => handleShareToChat(block)} label="Share to Chat" />
                                                <ActionBtn icon={Trash2} onClick={() => handleDelete(blockId)} label="Delete" variant="danger" />
                                            </div>
                                        </div>

                                        {/* Block content */}
                                        <div className={`px-3.5 pb-3.5 ${expandedBlockId === blockId ? 'max-h-none' : 'max-h-[500px] overflow-y-auto custom-scrollbar'}`}>
                                            {renderBlockContent(block)}
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </AnimatePresence>
                    )}
                </div>
            </div>

            {/* ═══ FOOTER ═══ */}
            <div className="px-4 py-2.5 border-t border-gray-200 bg-gradient-to-r from-gray-100 to-transparent flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Zap size={11} className="text-cyan-400" />
                    <span className="text-[9px] text-gray-900 font-bold tracking-wider uppercase">Realtime Sync</span>
                </div>
                <span className="text-[8px] text-gray-900 font-mono tracking-widest uppercase">CANVAS_V2_INTERACTIVE</span>
            </div>
        </motion.div>
    );
};

export default Canvas;
