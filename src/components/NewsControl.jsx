import React, { useState, useEffect } from 'react';
import { Newspaper, Filter, Loader2, RefreshCcw, Sparkles, ExternalLink, Quote, BookOpen } from 'lucide-react';
import { newsAgent } from '../utils/newsAgent';
import ReactMarkdown from 'react-markdown';
import { config } from '../utils/config';

const NewsControl = () => {
    const [loading, setLoading] = useState(false);
    const [articles, setArticles] = useState([]);
    const [summary, setSummary] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [error, setError] = useState(null);

    const handleFetch = async () => {
        if (!searchQuery.trim() && articles.length === 0) {
            setSearchQuery("Latest global headlines and tech trends");
        }
        
        setLoading(true);
        setError(null);
        setSummary('');
        try {
            const results = await newsAgent.fetch({
                searchQuery: searchQuery || "Latest global news"
            });

            if (results && results.length > 0) {
                setArticles(results);
                // Trigger AI Summarization
                generateAISummary(results);
            } else {
                setArticles([]);
                setError("Agent could not find any fresh intelligence on this topic.");
            }
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const generateAISummary = async (data) => {
        const cloudKey = config.getApiKey('VITE_OLLAMA_CLOUD_API_KEY');
        const baseUrl = import.meta.env.VITE_BACKEND_URL || '';
        
        if (!cloudKey) {
            setSummary("AI Summary unavailable (Cloud Key missing). Please check raw sources below.");
            return;
        }

        try {
            const context = data.slice(0, 8).map(a => `[Source: ${a.source.name}] ${a.title}: ${a.description}`).join('\n');
            const prompt = `You are Liya, a high-tech intelligence agent. Summarize the following news articles about "${searchQuery}" into a crisp, professional, and insightful report. 
            Use bullet points for key events. 
            Keep it under 250 words. 
            Start with a short greeting in Hindi/Hinglish.
            Context:\n${context}`;

            const response = await fetch(`${baseUrl}/cloud-api/api/generate`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cloudKey}`
                },
                body: JSON.stringify({
                    model: localStorage.getItem('OLLAMA_NEWS_MODEL') || 'gemma4:31b-cloud',
                    prompt: prompt,
                    stream: false
                })
            });

            const aiData = await response.json();
            setSummary(aiData.response || "Failed to synthesize report.");
        } catch (e) {
            console.error("Summary Error:", e);
            setSummary("System Error: Could not generate AI intelligence report.");
        }
    };

    return (
        <div className="p-4 md:p-6 h-full flex flex-col max-w-5xl mx-auto w-full pb-20 md:pb-6 font-mono">
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
                    <Newspaper className="text-accent-red" />
                    INTELLIGENCE HUB
                </h2>
                <div className="flex items-center gap-2 px-3 py-1 bg-accent-red/10 border border-accent-red/20 rounded-full">
                    <Sparkles size={14} className="text-accent-red animate-pulse" />
                    <span className="text-[10px] font-bold text-accent-red tracking-widest uppercase">Neural Agent v2.0</span>
                </div>
            </div>

            {/* Search Bar */}
            <div className="flex flex-col md:flex-row gap-4 mb-8 bg-white p-3 md:p-4 rounded-2xl border border-gray-300 shadow-2xl">
                <div className="flex-1 flex items-center bg-gray-100 rounded-xl border border-gray-300 px-4 py-3">
                    <Filter size={18} className="text-gray-600 mr-3" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="What would you like to know? (e.g. 'SpaceX progress', 'AI in India')..."
                        className="bg-transparent text-sm w-full outline-none text-gray-900 placeholder-gray-600 font-mono"
                        onKeyDown={(e) => e.key === 'Enter' && handleFetch()}
                    />
                </div>
                <button
                    onClick={handleFetch}
                    disabled={loading}
                    className="flex items-center justify-center gap-3 px-8 py-3 bg-accent-red hover:bg-[#d60032] text-gray-900 rounded-xl font-bold transition-all disabled:opacity-50 shadow-[0_0_20px_rgba(var(--rgb-accent-red), 0.4)] active:scale-95"
                >
                    {loading ? <Loader2 size={20} className="animate-spin" /> : <Sparkles size={20} />}
                    <span className="tracking-widest text-xs">DISCOVER</span>
                </button>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-6">
                
                {loading && !summary && (
                    <div className="flex flex-col items-center justify-center h-64 space-y-4">
                        <div className="w-12 h-12 border-4 border-accent-red/20 border-t-accent-red rounded-full animate-spin"></div>
                        <p className="text-accent-red text-xs font-bold animate-pulse tracking-[0.2em]">ANALYZING GLOBAL DATASTREAMS...</p>
                    </div>
                )}

                {summary && (
                    <div className="bg-gray-100 border border-gray-300 rounded-3xl p-6 md:p-8 shadow-inner backdrop-blur-md relative overflow-hidden group">
                        <div className="absolute top-0 left-0 w-1 h-full bg-accent-red"></div>
                        <div className="flex items-center gap-2 mb-4 text-accent-red">
                            <Quote size={20} />
                            <span className="text-xs font-bold tracking-[0.3em] uppercase">Executive Intelligence Report</span>
                        </div>
                        <div className="prose max-w-none text-gray-800 leading-relaxed text-sm md:text-base prose-headings:text-gray-900 prose-a:text-accent-red prose-strong:text-gray-900">
                            <ReactMarkdown>{summary}</ReactMarkdown>
                        </div>
                    </div>
                )}

                {/* Sources Bar */}
                {articles.length > 0 && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-gray-500 px-2">
                            <BookOpen size={14} />
                            <span className="text-[10px] font-bold uppercase tracking-widest">Verified Sources</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {articles.slice(0, 10).map((article, idx) => (
                                <a 
                                    key={idx} 
                                    href={article.url} 
                                    target="_blank" 
                                    rel="noreferrer"
                                    className="flex items-center gap-2 px-3 py-2 bg-gray-100 hover:bg-accent-red/20 border border-gray-300 hover:border-accent-red/50 rounded-lg transition-all text-[10px] text-gray-600 hover:text-gray-900"
                                >
                                    <div className="w-4 h-4 bg-accent-red/10 rounded flex items-center justify-center">
                                        <span className="text-[8px] text-accent-red font-bold">{article.source.name[0]}</span>
                                    </div>
                                    <span className="max-w-[120px] truncate">{article.title}</span>
                                    <ExternalLink size={10} className="opacity-50" />
                                </a>
                            ))}
                        </div>
                    </div>
                )}

                {error && (
                    <div className="p-4 bg-red-500/10 border border-red-500/50 text-red-500 rounded-xl text-xs flex items-center gap-3">
                        <div className="w-2 h-2 bg-red-500 rounded-full animate-ping"></div>
                        {error}
                    </div>
                )}

                {!loading && !summary && !error && (
                    <div className="h-64 flex flex-col items-center justify-center text-gray-700 opacity-30">
                        <Sparkles size={60} strokeWidth={1} />
                        <p className="mt-4 text-xs tracking-[0.5em] uppercase font-bold text-center">Awaiting Command Target</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default NewsControl;
