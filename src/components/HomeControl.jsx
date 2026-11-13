import React, { useState, useEffect } from 'react';
import { Home, Lightbulb, Tv, Power, RefreshCcw, Loader2, Zap, ShieldCheck, Settings, Layout, Radio } from 'lucide-react';
import { toggleDevice } from '../utils/sinric';
import { getDynamicSinricConfig } from '../utils/homeConfig';
import { motion, AnimatePresence } from 'framer-motion';

const HomeControl = () => {
    const [devices, setDevices] = useState([]);
    const [loading, setLoading] = useState({});
    const [status, setStatus] = useState(null);

    useEffect(() => {
        const config = getDynamicSinricConfig();
        const seenIds = new Set();
        const deviceList = Object.entries(config.devices)
            .filter(([_, id]) => {
                if (id && !seenIds.has(id)) {
                    seenIds.add(id);
                    return true;
                }
                return false;
            })
            .map(([name, id]) => ({
                name: name.charAt(0).toUpperCase() + name.slice(1),
                id: id,
                type: name.toLowerCase().includes('light') ? 'light' : name.toLowerCase().includes('tv') ? 'tv' : 'device',
                isOn: false 
            }));
        setDevices(deviceList);
    }, []);

    const handleToggle = async (deviceName, targetState) => {
        setLoading(prev => ({ ...prev, [deviceName]: true }));
        try {
            const result = await toggleDevice(deviceName, targetState);
            setStatus({ type: 'success', message: result });
            setDevices(prev => prev.map(d => 
                d.name.toLowerCase() === deviceName.toLowerCase() ? { ...d, isOn: targetState } : d
            ));
        } catch (error) {
            setStatus({ type: 'error', message: `Failed to control ${deviceName}` });
        } finally {
            setLoading(prev => ({ ...prev, [deviceName]: false }));
            setTimeout(() => setStatus(null), 3000);
        }
    };

    const getIcon = (type) => {
        switch (type) {
            case 'light': return <Lightbulb size={24} />;
            case 'tv': return <Tv size={24} />;
            default: return <Radio size={24} />;
        }
    };

    return (
        <div className="relative p-4 md:p-6 h-full flex flex-col w-full overflow-hidden bg-gray-50">
            
            {/* ADVANCED RADAR BACKGROUND */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="absolute w-full h-full bg-[radial-gradient(circle_at_50%_50%,var(--color-accent-blue)_0%,transparent_70%)]" />
                <div className="absolute inset-0 opacity-[0.02]" style={{ backgroundImage: 'radial-gradient(#00f3ff 1px, transparent 1px)', backgroundSize: '30px 30px' }} />
                
                {[1, 2, 3].map((i) => (
                    <motion.div
                        key={i}
                        initial={{ scale: 0.3, opacity: 0 }}
                        animate={{ scale: [0.3, 1.5], opacity: [0, 0.3, 0] }}
                        transition={{
                            duration: 10,
                            repeat: Infinity,
                            delay: i * 3,
                            ease: "linear"
                        }}
                        className="absolute w-[500px] h-[500px] border-[0.5px] border-accent-blue/20 rounded-full"
                    />
                ))}
            </div>

            {/* TOP BAR */}
            <div className="flex items-center justify-between mb-8 relative z-10">
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]" />
                    </div>
                    <span className="text-[9px] font-black text-gray-500 font-mono tracking-[0.2em] uppercase">Neural Hub Online</span>
                </div>
                <div className="flex items-center gap-4">
                    <span className="text-[9px] font-bold text-accent-blue font-mono">v3.0.2</span>
                    <Layout size={14} className="text-gray-800" />
                </div>
            </div>

            {/* HEADER SECTION */}
            <div className="flex items-center gap-6 mb-10 relative z-10">
                <div className="relative group">
                    <div className="w-12 h-12 bg-gradient-to-br from-accent-red to-[#990024] rounded-xl flex items-center justify-center border border-gray-300 relative">
                        <Zap size={24} className="text-gray-900 fill-white" />
                    </div>
                </div>
                <div>
                    <h2 className="text-3xl font-black text-gray-900 tracking-tighter uppercase leading-none mb-1">
                        HOME <span className="text-transparent bg-clip-text bg-gradient-to-r from-white to-white/30">CONTROL</span>
                    </h2>
                    <p className="text-[9px] font-black text-accent-blue font-mono tracking-[0.3em] uppercase opacity-70">Sinric Gateway Active</p>
                </div>
            </div>

            {/* CYBER-GRID DEVICES */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 relative z-10 max-w-7xl w-full">
                {devices.map((device) => (
                    <motion.div 
                        key={device.id}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => handleToggle(device.name, !device.isOn)}
                        className={`
                            relative group cursor-pointer
                            bg-white  backdrop-blur-xl border border-gray-200  rounded-3xl
                            p-6 flex flex-col items-center justify-center
                            transition-all duration-500
                            ${device.isOn 
                                ? 'border-accent-blue/30 shadow-[0_0_40px_var(--color-accent-blue)] bg-white/[0.03]' 
                                : 'hover:border-gray-300 '
                            }
                        `}
                    >
                        {/* Device Status Ring */}
                        <div className="absolute top-4 right-6 flex items-center gap-1.5">
                            <div className={`w-1 h-1 rounded-full ${device.isOn ? 'bg-accent-blue shadow-[0_0_8px_var(--color-accent-blue)]' : 'bg-gray-800'}`} />
                        </div>

                        {/* Premium Icon Container */}
                        <div className={`
                            w-16 h-16 rounded-2xl flex items-center justify-center mb-6 transition-all duration-500 relative
                            ${device.isOn 
                                ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/20' 
                                : 'bg-white/[0.01] border border-gray-200  text-gray-700'
                            }
                        `}>
                            {loading[device.name] ? (
                                <Loader2 size={24} className="animate-spin" />
                            ) : (
                                getIcon(device.type)
                            )}
                        </div>

                        {/* Device Identity */}
                        <h3 className="text-sm font-black text-gray-900 tracking-widest uppercase text-center mb-1">
                            {device.name}
                        </h3>
                        <p className="text-[8px] font-bold text-gray-600 font-mono uppercase tracking-widest">
                            {device.isOn ? 'Protocol Active' : 'Standby'}
                        </p>
                    </motion.div>
                ))}
            </div>

            {/* GLOBAL NOTIFICATION SYSTEM */}
            <AnimatePresence>
                {status && (
                    <motion.div 
                        initial={{ y: 50, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: 50, opacity: 0 }}
                        className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 w-full max-w-xs"
                    >
                        <div className={`
                            px-6 py-3 rounded-2xl border backdrop-blur-2xl font-mono text-[9px] font-black uppercase tracking-widest flex items-center gap-3 shadow-2xl
                            ${status.type === 'success' ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}
                        `}>
                            <div className={`w-1.5 h-1.5 rounded-full ${status.type === 'success' ? 'bg-green-500' : 'bg-red-500'}`} />
                            {status.message}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default HomeControl;