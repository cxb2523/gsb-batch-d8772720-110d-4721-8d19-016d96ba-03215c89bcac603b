import React from 'react';
import { Menu, ChevronDown, Layout, X } from 'lucide-react';
import { stopSpeech } from '../utils/speechUtils';

const Header = ({
    setIsMobileMenuOpen,
    isPlaying,
    activeModule,
    setActiveModule,
    isCanvasVisible,
    setIsCanvasVisible
}) => {
    return (
        <header className="h-14 flex items-center justify-between px-4 sticky top-0 z-10 bg-white">
            <div className="flex items-center gap-2">
                {/* Mobile Menu Toggle */}
                <button
                    onClick={() => setIsMobileMenuOpen(true)}
                    className="p-2 -ml-2 text-gray-500 hover:text-gray-900 md:hidden rounded-md hover:bg-gray-100"
                >
                    <Menu size={20} />
                </button>
                
                {/* Minimal Model Selector (ChatGPT Style) */}
                <div className="flex items-center gap-2">
                    <button className="flex items-center gap-2 px-2 py-1 hover:bg-gray-100 rounded-lg transition-colors text-gray-800 font-bold text-[15px]">
                        <img src="/liya_logo.png" alt="LIYA" className="w-6 h-6 rounded-lg object-cover shadow-sm ring-1 ring-black/10" />
                        <span className="font-extrabold tracking-wide">LIYA AI</span>
                        <ChevronDown size={16} className="text-gray-400" />
                    </button>
                </div>
            </div>

            <div className="flex items-center gap-2">
                {activeModule !== 'chat' && (
                    <button
                        onClick={() => setActiveModule('chat')}
                        className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-100 hover:bg-red-500 hover:text-white text-gray-600 transition-all shadow-sm border border-gray-200"
                        title="Close App"
                    >
                        <X size={16} />
                    </button>
                )}
                <button
                    onClick={() => setIsCanvasVisible(!isCanvasVisible)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${isCanvasVisible ? 'bg-gray-100 border-gray-300 text-gray-800' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                >
                    <Layout size={16} />
                    <span className="hidden sm:inline">Canvas</span>
                </button>
            </div>
        </header>
    );
};

export default React.memo(Header);
