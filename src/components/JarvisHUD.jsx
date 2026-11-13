import React, { useRef, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
    Cpu, MemoryStick as Memory, Activity, Terminal, ShieldAlert,
    Volume2, Chrome, FileCode, Folder, FileText, Zap 
} from 'lucide-react';
import { io } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

export default function JarvisHUD({ aiState = 'idle', activeTools = [] }) {
    const canvasRef = useRef(null);
    const [stats, setStats] = useState({ cpu: 0, ram: 0, uptime: '0h', platform: 'loading...' });
    const [logs, setLogs] = useState([]);
    const [volume, setVolume] = useState(50);
    const [launching, setLaunching] = useState(null);
    
    // Connect to backend for real-time telemetry
    useEffect(() => {
        const socket = io(BACKEND_URL);
        socket.on('system-stats', (newStats) => {
            setStats(newStats);
        });

        // Generate synthetic Jarvis logs for high-tech look
        const defaultLogs = [
            'SYS_INIT: Establishing secure connection...',
            'LINK: Neural OS Core synced with master mainframe.',
            'TELEMETRY: Diagnostic modules online.',
            'INTERFACE: Liya HUD V3 loaded successfully.'
        ];
        setLogs(defaultLogs);

        const logTimer = setInterval(() => {
            const possibleLogs = [
                `NEURAL_NET: Analyzing ambient queries...`,
                `SYNC: Latency check at 12ms. Status: Optimal.`,
                `SEC_INTEGRITY: Firewall shields active (100%)`,
                `CORE_TEMP: Processor thermal state stable at 42°C`,
                `MEMORY: RAM cache optimized. Garbage collected.`,
                `AGENT_COMM: Subagent channels listening...`
            ];
            const randomLog = possibleLogs[Math.floor(Math.random() * possibleLogs.length)];
            setLogs(prev => [randomLog, ...prev.slice(0, 5)]);
        }, 6000);

        return () => {
            socket.disconnect();
            clearInterval(logTimer);
        };
    }, []);

    // Push execution logs when tools are active
    useEffect(() => {
        if (activeTools && activeTools.length > 0) {
            const newLogs = activeTools.map(t => `EXECUTING_TOOL: ${(t.type || 'block').toUpperCase()} with payload.`);
            setLogs(prev => [...newLogs, ...prev.slice(0, 5)]);
        }
    }, [activeTools]);

    // Handle Volume Controller changes with 200ms debounce
    const handleVolumeChange = (e) => {
        const val = parseInt(e.target.value);
        setVolume(val);
    };

    useEffect(() => {
        const timer = setTimeout(() => {
            fetch(`${BACKEND_URL}/api/system/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'volume', value: volume })
            })
            .then(() => {
                setLogs(prev => [`VOLUME_SYNC: System volume set to ${volume}%`, ...prev.slice(0, 5)]);
            })
            .catch(err => console.error("Volume Sync Error:", err));
        }, 200);
        return () => clearTimeout(timer);
    }, [volume]);

    // Handle Application Launching
    const launchApp = (appName) => {
        setLaunching(appName);
        setLogs(prev => [`SYS_LAUNCH: Requesting execution of '${appName.toUpperCase()}'...`, ...prev.slice(0, 5)]);
        
        fetch(`${BACKEND_URL}/api/system/launch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app: appName })
        })
        .then(() => {
            setLogs(prev => [`SYS_LAUNCH: Successfully started '${appName.toUpperCase()}'`, ...prev.slice(0, 5)]);
        })
        .catch(err => {
            setLogs(prev => [`SYS_LAUNCH_ERROR: Failed to start '${appName.toUpperCase()}'`, ...prev.slice(0, 5)]);
        })
        .finally(() => {
            setTimeout(() => setLaunching(null), 1000);
        });
    };

    // Holographic Canvas Render Loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let animationFrameId;
        
        let rotationAngle = 0;
        let pulseDirection = 1;
        let pulseScale = 1;
        
        // Particles system
        const particles = [];
        for (let i = 0; i < 40; i++) {
            particles.push({
                x: Math.random() * 300 - 150,
                y: Math.random() * 300 - 150,
                size: Math.random() * 1.5 + 0.5,
                speed: Math.random() * 1 + 0.2,
                angle: Math.random() * Math.PI * 2,
                opacity: Math.random() * 0.5 + 0.2
            });
        }

        const resize = () => {
            canvas.width = canvas.parentElement.clientWidth;
            canvas.height = 320;
        };
        resize();
        window.addEventListener('resize', resize);

        const render = () => {
            const w = canvas.width;
            const h = canvas.height;
            const cx = w / 2;
            const cy = h / 2;
            
            // Adjust speed based on AI state
            let speedFactor = 1;
            let themeColor = 'rgba(0, 243, 255, '; // Cyan (Idle)
            let coreColor = '#00f3ff';
            
            if (aiState === 'thinking') {
                speedFactor = 4;
                themeColor = 'rgba(168, 85, 247, '; // Purple (Thinking)
                coreColor = '#a855f7';
            } else if (aiState === 'executing' || activeTools.length > 0) {
                speedFactor = 6;
                themeColor = 'rgba(236, 72, 153, '; // Pink/Red (Executing)
                coreColor = '#ec4899';
            }

            rotationAngle += 0.005 * speedFactor;
            
            // Pulse logic
            pulseScale += 0.005 * pulseDirection * (speedFactor * 0.5);
            if (pulseScale > 1.08) pulseDirection = -1;
            if (pulseScale < 0.95) pulseDirection = 1;

            ctx.clearRect(0, 0, w, h);

            // Draw Background Grid (Sci-fi feel)
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
            ctx.lineWidth = 1;
            const gridSpacing = 20;
            for (let x = 0; x < w; x += gridSpacing) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            }
            for (let y = 0; y < h; y += gridSpacing) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
            }

            // Draw Concentric Rings (Arc Reactor Style)
            ctx.save();
            ctx.translate(cx, cy);
            ctx.scale(pulseScale, pulseScale);
            
            // Glow effect
            ctx.shadowBlur = 15;
            ctx.shadowColor = coreColor;

            // Outer Ring 1 (Dotted)
            ctx.strokeStyle = themeColor + '0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(0, 0, 110, 0, Math.PI * 2);
            ctx.stroke();

            // Ring 2 (Dashed & Rotating)
            ctx.strokeStyle = themeColor + '0.4)';
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 12]);
            ctx.beginPath();
            ctx.arc(0, 0, 95, rotationAngle, rotationAngle + Math.PI * 2);
            ctx.stroke();

            // Ring 3 (Concentric Crosshair)
            ctx.strokeStyle = themeColor + '0.2)';
            ctx.lineWidth = 1;
            ctx.setLineDash([]);
            ctx.beginPath(); ctx.arc(0, 0, 80, 0, Math.PI * 2); ctx.stroke();
            
            // Concentric sweep tick
            ctx.strokeStyle = themeColor + '0.8)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(0, 0, 80, -rotationAngle * 1.5, -rotationAngle * 1.5 + 0.4);
            ctx.stroke();

            // Inside Segments (Arc reactor brackets)
            ctx.strokeStyle = themeColor + '0.5)';
            ctx.lineWidth = 4;
            ctx.setLineDash([20, 15]);
            ctx.beginPath();
            ctx.arc(0, 0, 60, -rotationAngle, -rotationAngle + Math.PI * 2);
            ctx.stroke();

            // Inner Core Target Reticles
            ctx.setLineDash([]);
            ctx.strokeStyle = themeColor + '0.6)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-45, 0); ctx.lineTo(-30, 0);
            ctx.moveTo(30, 0); ctx.lineTo(45, 0);
            ctx.moveTo(0, -45); ctx.lineTo(0, -30);
            ctx.moveTo(0, 30); ctx.lineTo(0, 45);
            ctx.stroke();

            // Glowing Core Orb
            const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(0.3, coreColor);
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(0, 0, 18, 0, Math.PI * 2);
            ctx.fill();

            // Render HUD orbiting particles
            particles.forEach(p => {
                p.angle += 0.01 * p.speed * speedFactor;
                const distance = 60 + Math.sin(p.angle) * 35;
                const px = Math.cos(p.angle) * distance;
                const py = Math.sin(p.angle) * distance;
                
                ctx.fillStyle = themeColor + p.opacity + ')';
                ctx.beginPath();
                ctx.arc(px, py, p.size, 0, Math.PI * 2);
                ctx.fill();
            });

            ctx.restore();

            // Diagnostic Tech Data Overlay (Pure Sci-Fi Aesthetics)
            ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.font = '8px monospace';
            ctx.fillText(`ROTATION_SPD: ${(0.005 * speedFactor * 1000).toFixed(1)} RPM`, 15, 25);
            ctx.fillText(`CORE_INTEGRITY: 100%`, 15, 38);
            ctx.fillText(`THERMAL_STAT: STABLE`, 15, 51);

            ctx.textAlign = 'right';
            ctx.fillText(`AI_STATE: ${aiState.toUpperCase()}`, w - 15, 25);
            ctx.fillText(`ACTIVE_SYNS: ${(particles.length * speedFactor).toFixed(0)}`, w - 15, 38);
            ctx.fillText(`HUD_FPS: 60`, w - 15, 51);
            ctx.textAlign = 'left';

            animationFrameId = requestAnimationFrame(render);
        };
        render();

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', resize);
        };
    }, [aiState, activeTools]);

    return (
        <div className="space-y-5 animate-in fade-in zoom-in duration-75">
            {/* Holographic ARC Core */}
            <div className="relative bg-white/[0.01] border border-white/[0.04] rounded-2xl overflow-hidden shadow-[inset_0_0_30px_var(--color-accent-blue)]">
                <canvas ref={canvasRef} className="w-full block" />
                
                {/* JARVIS Status Overlay */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none text-center select-none z-10">
                    <p className="text-[10px] font-black tracking-[0.3em] text-gray-900 uppercase mb-0.5">Neural Mainframe</p>
                    <h3 className="text-sm font-black text-gray-900 uppercase tracking-wider">
                        {aiState === 'thinking' ? 'PROCESSING...' : aiState === 'executing' ? 'EXECUTING...' : 'LIYA ACTIVE'}
                    </h3>
                </div>
            </div>

            {/* Neural Diagnostics HUD */}
            <div className="grid grid-cols-3 gap-3">
                <DiagRing label="CPU Core" val={stats.cpu} icon={Cpu} color="cyan" />
                <DiagRing label="RAM Cache" val={stats.ram} icon={Memory} color={aiState === 'thinking' ? 'purple' : 'cyan'} />
                <DiagRing label="Core Latency" val={12} icon={Activity} color="emerald" customVal="12ms" />
            </div>

            {/* Holographic Volume Controller */}
            <div className="bg-white/[0.01] border border-white/[0.04] p-3.5 rounded-2xl space-y-3 shadow-[inset_0_0_15px_rgba(255,255,255,0.01)] hover:border-gray-300 transition-all select-none">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Volume2 size={13} className="text-cyan-400 animate-pulse" />
                        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-900">Holographic Volume</span>
                    </div>
                    <span className="text-xs font-mono text-cyan-400 font-black">{volume}%</span>
                </div>
                <input 
                    type="range" 
                    min="0" max="100" 
                    value={volume}
                    onChange={handleVolumeChange}
                    className="w-full h-1 bg-gray-100 rounded-lg appearance-none cursor-pointer accent-cyan-400 outline-none transition-all hover:bg-white/10"
                />
            </div>

            {/* Premium sci-fi App Launcher Shortcuts */}
            <div className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                    <Zap size={11} className="text-amber-400 animate-pulse" />
                    <span className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-900">Subsystem Launcher</span>
                </div>
                <div className="grid grid-cols-5 gap-2">
                    {[
                        { id: 'chrome', icon: Chrome, label: 'Chrome', color: 'group-hover:text-blue-400' },
                        { id: 'vscode', icon: FileCode, label: 'VS Code', color: 'group-hover:text-cyan-500' },
                        { id: 'notepad', icon: FileText, label: 'Notepad', color: 'group-hover:text-zinc-400' },
                        { id: 'terminal', icon: Terminal, label: 'Terminal', color: 'group-hover:text-emerald-400' },
                        { id: 'thispc', icon: Folder, label: 'Explorer', color: 'group-hover:text-amber-400' },
                    ].map((app) => (
                        <button
                            key={app.id}
                            onClick={() => launchApp(app.id)}
                            disabled={launching === app.id}
                            className={`flex flex-col items-center justify-center py-2.5 px-1.5 rounded-xl border border-white/[0.04] bg-white/[0.01] hover:bg-gray-100  hover:border-gray-300  transition-all group ${launching === app.id ? 'opacity-30' : ''}`}
                        >
                            <app.icon size={18} className={`text-gray-900  mb-1.5 transition-all duration-300 ${app.color} group-hover:scale-110`} />
                            <span className="text-[7.5px] font-bold text-gray-900 uppercase tracking-tighter truncate w-full max-w-[55px] text-center">
                                {launching === app.id ? '...' : app.label}
                            </span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Matrix Terminal Ticker */}
            <div className="bg-white border border-white/[0.05] rounded-xl p-3.5 font-mono space-y-1.5 min-h-[110px] relative overflow-hidden backdrop-blur-md">
                <div className="flex items-center justify-between pb-1.5 border-b border-gray-200 opacity-55">
                    <div className="flex items-center gap-1.5">
                        <Terminal size={10} className="text-cyan-400 animate-pulse" />
                        <span className="text-[9px] uppercase tracking-wider font-bold">LIYA Core Terminal</span>
                    </div>
                    <span className="text-[8px] bg-cyan-500/10 text-cyan-400 px-1 rounded font-bold">SYS_OK</span>
                </div>
                <div className="space-y-1 select-none">
                    <AnimatePresence initial={false}>
                        {logs.map((log, i) => (
                            <motion.div
                                key={log + i}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1 - i * 0.15, x: 0 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.15 }}
                                className="text-[9.5px] tracking-tight leading-tight flex items-start gap-1 font-bold"
                            >
                                <span className="text-cyan-500/60 font-black">➜</span>
                                <span className={log.includes('EXECUTING') ? 'text-pink-400' : log.includes('ALERT') ? 'text-red-400' : 'text-gray-900 '}>
                                    {log}
                                </span>
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </div>
                <div className="absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-t from-black/40 to-transparent pointer-events-none" />
            </div>
        </div>
    );
}

// Interactive SVG Gauge
function DiagRing({ label, val, icon: Icon, color, customVal }) {
    const radius = 22;
    const stroke = 3;
    const normalizedRadius = radius - stroke * 2;
    const circumference = normalizedRadius * 2 * Math.PI;
    const strokeDashoffset = circumference - (Math.min(val, 100) / 100) * circumference;

    const colors = {
        cyan: 'stroke-cyan-400 text-cyan-400 bg-cyan-500/5',
        purple: 'stroke-purple-400 text-purple-400 bg-purple-500/5',
        emerald: 'stroke-emerald-400 text-emerald-400 bg-emerald-500/5',
    };

    return (
        <div className="bg-white/[0.01] border border-white/[0.04] p-3 rounded-2xl flex items-center justify-between hover:border-gray-300 transition-all select-none group">
            <div className="space-y-1">
                <p className="text-[9px] font-bold text-gray-900 uppercase tracking-widest">{label}</p>
                <div className="flex items-baseline gap-0.5">
                    <span className="text-[13px] font-black text-gray-900 font-mono">{customVal || `${val}%`}</span>
                </div>
            </div>
            <div className="relative flex items-center justify-center">
                <svg className="w-12 h-12 transform -rotate-90">
                    <circle
                        className="stroke-white/5"
                        fill="transparent"
                        strokeWidth={stroke}
                        r={normalizedRadius}
                        cx="24"
                        cy="24"
                    />
                    <circle
                        className={`transition-all duration-500 ease-out ${colors[color].split(' ')[0]}`}
                        fill="transparent"
                        strokeWidth={stroke}
                        strokeDasharray={circumference + ' ' + circumference}
                        style={{ strokeDashoffset }}
                        r={normalizedRadius}
                        cx="24"
                        cy="24"
                    />
                </svg>
                <div className={`absolute ${colors[color].split(' ')[1]}`}>
                    <Icon size={12} className="group-hover:scale-110 transition-transform" />
                </div>
            </div>
        </div>
    );
}
