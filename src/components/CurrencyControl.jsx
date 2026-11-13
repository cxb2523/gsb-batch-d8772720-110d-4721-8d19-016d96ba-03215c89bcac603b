import React, { useState } from 'react';
import { CircleDollarSign, ArrowRightLeft, TrendingUp, Loader2, Coins } from 'lucide-react';

const currencies = [
    { code: 'USD', name: 'US Dollar', symbol: '$' },
    { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
    { code: 'EUR', name: 'Euro', symbol: '€' },
    { code: 'GBP', name: 'British Pound', symbol: '£' },
    { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
    { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
    { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
    { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
    { code: 'AED', name: 'UAE Dirham', symbol: 'dh' }
];

const CurrencyControl = () => {
    const [amount, setAmount] = useState('1');
    const [from, setFrom] = useState('USD');
    const [to, setTo] = useState('INR');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [rate, setRate] = useState(null);
    const [error, setError] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(null);

    const handleSwap = () => {
        setFrom(to);
        setTo(from);
        setResult(null);
    };

    const handleConvert = async () => {
        if (!amount || isNaN(amount)) return;
        setLoading(true);
        setError(null);
        setResult(null);

        try {
            const API_KEY = import.meta.env.VITE_CURRENCY_API_KEY;
            if (!API_KEY) throw new Error("API Key Missing");

            // CurrencyLayer Free Tier Source is locked to USD.
            // We fetch quotes relative to USD.
            // URL: /currency/live?source=USD&currencies=FROM,TO
            const baseUrl = import.meta.env.VITE_BACKEND_URL || '';
            const res = await fetch(`${baseUrl}/currency/live?access_key=${API_KEY}&currencies=${from},${to}&source=USD&format=1`);
            const data = await res.json();

            if (!data.success) {
                if (data.error?.code === 104) throw new Error("API Monthly Limit Reached");
                throw new Error(data.error?.info || "Conversion Failed");
            }

            const quotes = data.quotes;
            console.log("Currency Quotes:", quotes); // Debug

            // Handle USD Base Case explicitly
            // If from is USD, rate is 1. Else look up USD<from>
            const usdToFrom = from === 'USD' ? 1 : quotes[`USD${from}`];
            const usdToTo = to === 'USD' ? 1 : quotes[`USD${to}`];

            if (!usdToFrom || !usdToTo) {
                console.error(`Missing Rate. From: ${usdToFrom}, To: ${usdToTo}`);
                throw new Error("Rate not available for this pair");
            }

            // Calculate Cross Rate
            // 1 FROM = (1 / usdToFrom) USD
            // Value in TO = (1 / usdToFrom) * usdToTo
            const exchangeRate = (1 / usdToFrom) * usdToTo;
            const convertedValue = parseFloat(amount) * exchangeRate;

            setRate(exchangeRate);
            setResult(convertedValue);
            setLastUpdated(new Date().toLocaleTimeString());

        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-6 h-full flex flex-col items-center justify-center max-w-2xl mx-auto w-full">
            <h2 className="text-2xl font-bold font-mono text-gray-900 mb-8 flex items-center gap-3">
                <CircleDollarSign className="text-[#00ff9d]" size={28} />
                LIVE MONEY EXCHANGE
            </h2>

            {/* Main Card */}
            <div className="w-full bg-white border border-gray-300 rounded-3xl p-8 shadow-[0_0_50px_rgba(0,255,157,0.05)] relative overflow-hidden">

                {/* Background Decor */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-[#00ff9d]/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                {/* Input Section */}
                <div className="flex flex-col gap-6 relative z-10">

                    {/* Amount */}
                    <div>
                        <label className="text-xs font-mono text-gray-500 uppercase tracking-widest mb-2 block">Amount</label>
                        <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-600 font-bold">$</span>
                            <input
                                type="number"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                className="w-full bg-gray-100 border border-gray-300 rounded-xl py-4 pl-10 pr-4 text-2xl text-gray-900 font-mono focus:border-[#00ff9d] focus:outline-none transition-all placeholder-gray-600"
                                placeholder="0.00"
                            />
                        </div>
                    </div>

                    {/* Swap Row */}
                    <div className="flex items-center gap-4">
                        <div className="flex-1">
                            <label className="text-xs font-mono text-gray-500 uppercase tracking-widest mb-2 block">From</label>
                            <select
                                value={from}
                                onChange={(e) => setFrom(e.target.value)}
                                className="w-full bg-gray-100 border border-gray-300 rounded-xl p-3 text-gray-900 font-mono outline-none cursor-pointer hover:bg-white/10"
                            >
                                {currencies.map(c => <option key={c.code} value={c.code} className="bg-white">{c.code} - {c.name}</option>)}
                            </select>
                        </div>

                        <button
                            onClick={handleSwap}
                            className="p-3 rounded-full bg-gray-100 hover:bg-[#00ff9d]/20 text-[#00ff9d] border border-gray-300 transition-all mt-6"
                        >
                            <ArrowRightLeft size={20} />
                        </button>

                        <div className="flex-1">
                            <label className="text-xs font-mono text-gray-500 uppercase tracking-widest mb-2 block">To</label>
                            <select
                                value={to}
                                onChange={(e) => setTo(e.target.value)}
                                className="w-full bg-gray-100 border border-gray-300 rounded-xl p-3 text-gray-900 font-mono outline-none cursor-pointer hover:bg-white/10"
                            >
                                {currencies.map(c => <option key={c.code} value={c.code} className="bg-white">{c.code} - {c.name}</option>)}
                            </select>
                        </div>
                    </div>

                </div>

                {/* Action Button */}
                <button
                    onClick={handleConvert}
                    disabled={loading}
                    className="w-full mt-8 bg-[#00ff9d] hover:bg-[#00cc7d] text-black font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed group"
                >
                    {loading ? <Loader2 className="animate-spin" /> : <Coins className="group-hover:scale-110 transition-transform" />}
                    CONVERT CURRENCY
                </button>
            </div>

            {/* Error */}
            {error && (
                <div className="mt-6 p-4 w-full bg-red-500/10 border border-red-500/50 text-red-500 rounded-lg text-center font-mono text-sm">
                    {error}
                </div>
            )}

            {/* Result Display */}
            {result !== null && !loading && !error && (
                <div className="mt-8 text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div className="text-gray-500 text-sm font-mono mb-2">
                        1 {from} = {rate.toFixed(4)} {to}
                    </div>
                    <div className="text-5xl font-bold text-gray-900 tracking-tight mb-2">
                        {currencies.find(c => c.code === to)?.symbol}{result.toFixed(2)}
                    </div>
                    <div className="flex items-center justify-center gap-2 text-[#00ff9d] text-xs font-mono uppercase tracking-widest bg-[#00ff9d]/5 border border-[#00ff9d]/20 px-3 py-1 rounded-full w-fit mx-auto">
                        <TrendingUp size={12} />
                        Live Market Rate • {lastUpdated}
                    </div>
                </div>
            )}

        </div>
    );
};

export default CurrencyControl;
