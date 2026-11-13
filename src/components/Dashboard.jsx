import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
    Cpu, 
    MemoryStick as Memory, 
    Volume2, 
    Monitor, 
    Chrome, 
    FileCode, 
    Terminal, 
    Folder, 
    FileText,
    Zap,
    Clock
} from 'lucide-react';
import { io } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

const Dashboard = () => {
    const [stats, setStats] = useState({ cpu: 0, ram: 0, uptime: '0h', platform: 'loading...' });
    const [volume, setVolume] = useState(50);
    const [launching, setLaunching] = useState(null);

    useEffect(() => {
        const socket = io(BACKEND_URL);
        socket.on('system-stats', (newStats) => {
            setStats(newStats);
        });

        // Fetch initial volume if possible (simplified here)
        return () => socket.disconnect();
    }, []);

    const handleVolumeChange = (e) => {
        const val = parseInt(e.target.value);
        setVolume(val);
    };

    // Debounced volume sync
    useEffect(() => {
        const timer = setTimeout(() => {
            fetch(`${BACKEND_URL}/api/system/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'volume', value: volume })
            }).catch(err => console.error("Volume Sync Error:", err));
        }, 200); // 200ms debounce
        return () => clearTimeout(timer);
    }, [volume]);

    const launchApp = (appName) => {
        setLaunching(appName);
        fetch(`${BACKEND_URL}/api/system/launch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app: appName })
        }).finally(() => {
            setTimeout(() => setLaunching(null), 1000);
        });
    };

    const apps = [
        { id: 'chrome', icon: Chrome, label: 'Chrome', color: 'text-blue-400' },
        { id: 'vscode', icon: FileCode, label: 'VS Code', color: 'text-blue-500' },
        { id: 'notepad', icon: FileText, label: 'Notepad', color: 'text-zinc-400' },
        { id: 'terminal', icon: Terminal, label: 'Terminal', color: 'text-emerald-400' },
        { id: 'thispc', icon: Folder, label: 'Explorer', color: 'text-amber-400' },
    ];

    return (
        <div className="space-y-6 animate-in fade-in zoom-in duration-500">
            {/* System Vitals Section */}
            <div className="grid grid-cols-2 gap-4">
                <MetricCard 
                    label="CPU Usage" 
                    value={stats.cpu} 
                    icon={Cpu} 
                    color="cyan" 
                />
                <MetricCard 
                    label="RAM Usage" 
                    value={stats.ram} 
                    icon={Memory} 
                    color="purple" 
                />
            </div>

            {/* Hardware Controls */}
            <div className="bg-white/[0.03] border border-gray-300 rounded-2xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Volume2 size={16} className="text-cyan-400" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-900">System Volume</span>
                    </div>
                    <span className="text-xs font-mono text-cyan-400">{volume}%</span>
                </div>
                <input 
                    type="range" 
                    min="0" max="100" 
                    value={volume}
                    onChange={handleVolumeChange}
                    className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />
            </div>

            {/* App Launcher */}
            <div className="space-y-3">
                <div className="flex items-center gap-2 px-1">
                    <Zap size={14} className="text-amber-400" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-900">Quick Launch Center</span>
                </div>
                <div className="grid grid-cols-3 gap-3">
                    {apps.map((app) => (
                        <button
                            key={app.id}
                            onClick={() => launchApp(app.id)}
                            disabled={launching === app.id}
                            className={`flex flex-col items-center justify-center p-3 rounded-xl border border-gray-300  bg-gray-50  hover:bg-white/10 hover:border-gray-400  transition-all group ${launching === app.id ? 'opacity-50' : ''}`}
                        >
                            <app.icon size={24} className={`${app.color} mb-2 group-hover:scale-110 transition-transform`} />
                            <span className="text-[9px] font-bold text-gray-900 uppercase tracking-tighter truncate w-full">
                                {launching === app.id ? '...' : app.label}
                            </span>
                        </button>
                    ))}
                </div>
            </div>

            {/* System Context Footer */}
            <div className="flex items-center justify-between px-2 opacity-40">
                <div className="flex items-center gap-1.5">
                    <Clock size={12} />
                    <span className="text-[10px] font-mono tracking-tighter uppercase">Uptime: {stats.uptime}</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <Monitor size={12} />
                    <span className="text-[10px] font-mono tracking-tighter uppercase">{stats.platform}</span>
                </div>
            </div>
        </div>
    );
};

const MetricCard = ({ label, value, icon: Icon, color }) => {
    const colorClasses = {
        cyan: 'text-cyan-400 border-cyan-500/20 bg-cyan-500/5',
        purple: 'text-purple-400 border-purple-500/20 bg-purple-500/5'
    };

    return (
        <div className={`p-4 rounded-2xl border ${colorClasses[color]} flex flex-col items-center text-center space-y-2`}>
            <Icon size={20} className="mb-1" />
            <div>
                <p className="text-[10px] font-bold uppercase tracking-widest opacity-60">{label}</p>
                <div className="flex items-baseline justify-center gap-0.5">
                    <span className="text-2xl font-black">{value}</span>
                    <span className="text-xs opacity-40">%</span>
                </div>
            </div>
            {/* Tiny Progress Bar */}
            <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden mt-1">
                <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${value}%` }}
                    className={`h-full ${color === 'cyan' ? 'bg-cyan-500' : 'bg-purple-500'}`}
                />
            </div>
        </div>
    );
};

export default Dashboard;
