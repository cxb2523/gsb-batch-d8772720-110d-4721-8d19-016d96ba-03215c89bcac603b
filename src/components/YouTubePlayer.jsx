import React from 'react';
import { Youtube, ExternalLink, Maximize2, Music } from 'lucide-react';

const YouTubePlayer = ({ block }) => {
    const { videoId, title } = block;

    return (
        <div className="relative group overflow-hidden rounded-2xl bg-white border border-gray-300 shadow-2xl animate-in fade-in zoom-in duration-500">
            {/* Header / Info Bar */}
            <div className="absolute top-0 left-0 right-0 z-10 p-4 bg-gradient-to-b from-black/80 to-transparent flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-red-600 rounded-lg">
                        <Youtube size={14} className="text-gray-900" />
                    </div>
                    <span className="text-[10px] font-bold text-gray-900 truncate max-w-[200px] drop-shadow-md">
                        {title || 'YouTube Media'}
                    </span>
                </div>
                <button 
                    onClick={() => window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank')}
                    className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-gray-900 hover:text-gray-900"
                >
                    <ExternalLink size={14} />
                </button>
            </div>

            {/* Video Container */}
            <div className="relative pt-[56.25%] w-full overflow-hidden bg-zinc-900">
                <iframe
                    className="absolute top-0 left-0 w-full h-full border-none"
                    src={`https://www.youtube.com/embed/${videoId}?autoplay=1&mute=0&modestbranding=1&rel=0`}
                    title={title || "YouTube Video"}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                ></iframe>
            </div>

            {/* Footer / Status Bar */}
            <div className="p-3 bg-gray-50 border-t border-gray-300 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse shadow-[0_0_5px_rgba(239,68,68,0.8)]"></div>
                    <span className="text-[9px] font-mono text-gray-900 tracking-wider uppercase">LIYA MUSIC BUDDY V1</span>
                </div>
                <div className="flex items-center gap-1.5 text-[9px] font-bold text-red-500/80">
                    <Music size={10} />
                    LIVE_STREAM
                </div>
            </div>

            {/* Decorative Glow */}
            <div className="absolute -inset-[2px] bg-gradient-to-r from-red-600/20 via-transparent to-red-600/20 rounded-2xl -z-10 blur-sm opacity-50"></div>
        </div>
    );
};

export default YouTubePlayer;
