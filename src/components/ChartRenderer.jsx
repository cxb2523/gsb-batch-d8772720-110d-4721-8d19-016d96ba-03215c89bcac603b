import React from 'react';
import {
    ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
    LineChart, Line, AreaChart, Area, CartesianGrid, PieChart, Pie, Cell
} from 'recharts';

const COLORS = ['#00f3ff', '#ff00aa', '#ff003c', '#4a90e2', '#00ff9f', '#ffeb3b'];

const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
        return (
            <div className="bg-[#08080c] border border-gray-400 p-2 rounded shadow-xl backdrop-blur-md">
                <p className="text-gray-300 text-xs font-mono">{label}</p>
                <p className="text-accent-blue font-bold text-sm">
                    {`${payload[0].name}: ${payload[0].value}`}
                </p>
            </div>
        );
    }
    return null;
};

const ChartRenderer = ({ type, data: rawData, title }) => {
    const [isMounted, setIsMounted] = React.useState(false);

    React.useEffect(() => {
        // Larger delay (800ms) to ensure parent dimensions (and animations) are fully settled
        const timer = setTimeout(() => setIsMounted(true), 800);
        return () => clearTimeout(timer);
    }, []);

    // === DATA NORMALIZATION ENGINE ===
    // LLMs are unpredictable — sometimes they send { data: [...] }, sometimes [...], 
    // sometimes stringified JSON, sometimes nested arrays. Handle ALL cases.
    let data = rawData;


    // Case 1: String data (LLM sent JSON as string)
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = null; }
    }

    // Case 2: Object with nested data property { data: [...] }
    if (data && !Array.isArray(data) && typeof data === 'object' && Array.isArray(data.data)) {
        data = data.data;
    }

    // Case 3: Nested array [[{...}]] — unwrap one level
    if (Array.isArray(data) && data.length === 1 && Array.isArray(data[0])) {
        data = data[0];
    }

    // Case 4: Ensure each item has a 'name' key (LLM might use 'label', 'year', 'category')
    if (Array.isArray(data) && data.length > 0 && data[0] && !data[0].name) {
        const altKeys = ['label', 'year', 'month', 'category', 'x', 'date', 'period'];
        const foundKey = altKeys.find(k => data[0][k] !== undefined);
        if (foundKey) {
            data = data.map(item => ({ ...item, name: String(item[foundKey]) }));
        }
    }

    if (!data || !Array.isArray(data) || data.length === 0 || !data[0]) {
        return (
            <div className="flex items-center justify-center p-4 border border-dashed border-gray-300 rounded-lg bg-white">
                <span className="text-[10px] text-gray-900 font-mono tracking-tighter uppercase">ERR_DATA_INVALID</span>
            </div>
        );
    }

    // Inference keys dynamically if not provided
    const keys = Object.keys(data[0] || {}).filter(k => k !== 'name' && k !== 'label');
    const dataKey = keys[0] || 'value'; // Fallback

    return (
        <div className="w-full h-full text-xs font-mono text-gray-500 relative flex flex-col">
            {title && <h3 className="text-[10px] font-mono text-cyan-400/60 mb-2 uppercase tracking-[0.2em] text-center">{title}</h3>}
            <div className="flex-1 w-full relative" style={{ minHeight: '250px', minWidth: '280px' }}>
                {isMounted ? (
                    <ResponsiveContainer width="100%" height={250} minWidth={280}>
                        {type === 'bar' && (
                            <BarChart data={data}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                                <XAxis dataKey="name" stroke="#666" tickLine={false} />
                                <YAxis stroke="#666" tickLine={false} />
                                <Tooltip content={<CustomTooltip />} />
                                <Bar dataKey={dataKey} fill="#00f3ff" radius={[4, 4, 0, 0]} animationDuration={1500} />
                            </BarChart>
                        )}

                        {type === 'line' && (
                            <LineChart data={data}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                                <XAxis dataKey="name" stroke="#666" tickLine={false} />
                                <YAxis stroke="#666" tickLine={false} />
                                <Tooltip content={<CustomTooltip />} />
                                <Line type="monotone" dataKey={dataKey} stroke="#ff00aa" strokeWidth={3} dot={{ r: 4, fill: '#ff00aa' }} activeDot={{ r: 6, fill: '#fff' }} animationDuration={1500} />
                            </LineChart>
                        )}

                        {type === 'area' && (
                            <AreaChart data={data}>
                                <defs>
                                    <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#00f3ff" stopOpacity={0.4} />
                                        <stop offset="95%" stopColor="#00f3ff" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                                <XAxis dataKey="name" stroke="#666" tickLine={false} />
                                <YAxis stroke="#666" tickLine={false} />
                                <Tooltip content={<CustomTooltip />} />
                                <Area type="monotone" dataKey={dataKey} stroke="#00f3ff" fillOpacity={1} fill="url(#colorVal)" animationDuration={1500} />
                            </AreaChart>
                        )}

                        {type === 'pie' && (
                            <PieChart>
                                <Tooltip content={<CustomTooltip />} />
                                <Pie
                                    data={data}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={60}
                                    outerRadius={80}
                                    fill="#8884d8"
                                    paddingAngle={5}
                                    dataKey={dataKey} // Usually 'value'
                                >
                                    {data.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                            </PieChart>
                        )}
                    </ResponsiveContainer>
                ) : (
                    <div className="flex items-center justify-center h-full">
                         <div className="w-12 h-0.5 bg-cyan-500/20 relative overflow-hidden">
                             <div className="absolute inset-0 bg-cyan-400/50 animate-shimmer"></div>
                         </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default React.memo(ChartRenderer);
