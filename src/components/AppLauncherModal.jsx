import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Home, Newspaper, CloudSun, CircleDollarSign, HardDrive, Shield, X, Sparkles
} from 'lucide-react';

const apps = [
    { icon: Newspaper, label: 'News Console', id: 'news', color: 'bg-red-500' },
    { icon: CloudSun, label: 'Weather', id: 'weather', color: 'bg-sky-400' },
    { icon: CircleDollarSign, label: 'Exchange', id: 'currency', color: 'bg-green-500' },
    { icon: Sparkles, label: 'Face Swap', id: 'faceswap', color: 'bg-amber-500' },
    { icon: Shield, label: 'System', id: 'system', color: 'bg-zinc-800' }
];

const AppLauncherModal = ({ isOpen, onClose, onSelectApp }) => {
    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/40 backdrop-blur-md z-[100]"
                    />

                    {/* Modal Content */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        className="fixed inset-0 z-[101] flex items-center justify-center pointer-events-none p-4 md:p-12"
                    >
                        <div className="bg-white/90 backdrop-blur-xl border border-white/40 shadow-2xl rounded-3xl p-8 max-w-xl w-full pointer-events-auto relative overflow-hidden">
                            {/* Glass highlights */}
                            <div className="absolute top-0 left-0 right-0 h-1/2 bg-gradient-to-b from-white/50 to-transparent pointer-events-none" />

                            <button
                                onClick={onClose}
                                className="absolute top-4 right-4 p-2 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-full transition-colors"
                            >
                                <X size={16} />
                            </button>

                            <div className="text-center mb-8 relative z-10">
                                <h2 className="text-2xl font-black tracking-tight text-gray-900 mb-1">Applications</h2>
                                <p className="text-xs font-medium text-gray-500 uppercase tracking-widest">Select a neural module</p>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 relative z-10">
                                {apps.map((app, idx) => (
                                    <motion.button
                                        key={app.id}
                                        initial={{ opacity: 0, y: 20 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: idx * 0.05 }}
                                        onClick={() => {
                                            onSelectApp(app.id);
                                            onClose();
                                        }}
                                        className="flex flex-col items-center gap-2 group focus:outline-none"
                                    >
                                        <div className={`w-14 h-14 rounded-2xl ${app.color} text-white flex items-center justify-center shadow-lg group-hover:scale-105 group-hover:shadow-xl transition-all duration-300 relative`}>
                                            <div className="absolute inset-0 bg-white/20 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity" />
                                            <app.icon size={24} />
                                        </div>
                                        <span className="text-xs font-bold text-gray-700 group-hover:text-gray-900 transition-colors">
                                            {app.label}
                                        </span>
                                    </motion.button>
                                ))}
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};

export default AppLauncherModal;
