import React, { useState } from 'react';
import { Cloud, CloudRain, Sun, Wind, Droplets, MapPin, Search, CloudLightning, CloudSnow } from 'lucide-react';
import { config } from '../utils/config';

const WeatherControl = ({ onWeatherUpdate }) => {
    const [city, setCity] = useState('');
    const [loading, setLoading] = useState(false);
    const [weather, setWeather] = useState(null);
    const [error, setError] = useState(null);

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!city.trim()) return;

        setLoading(true);
        setError(null);
        try {
            const baseUrl = import.meta.env.VITE_BACKEND_URL || '';
            const apiKey = config.getApiKey('VITE_WEATHER_API_KEY');

            if (!apiKey) throw new Error("Weather API Key is missing in System Settings.");

            const res = await fetch(`${baseUrl}/weather/data/2.5/weather?q=${city}&units=metric&appid=${apiKey}`);
            if (!res.ok) throw new Error("City not found");
            const data = await res.json();

            setWeather(data);
            if (onWeatherUpdate) onWeatherUpdate(data);

        } catch (e) {
            setError(e.message);
            setWeather(null);
        } finally {
            setLoading(false);
        }
    };

    const getWeatherIcon = (id) => {
        if (id >= 200 && id < 300) return <CloudLightning className="w-24 h-24 text-yellow-400 drop-shadow-[0_0_15px_rgba(250,204,21,0.5)]" />;
        if (id >= 300 && id < 600) return <CloudRain className="w-24 h-24 text-blue-400 drop-shadow-[0_0_15px_rgba(96,165,250,0.5)]" />;
        if (id >= 600 && id < 700) return <CloudSnow className="w-24 h-24 text-gray-900 drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]" />;
        if (id === 800) return <Sun className="w-24 h-24 text-orange-400 drop-shadow-[0_0_15px_rgba(251,146,60,0.5)] animate-pulse-slow" />;
        return <Cloud className="w-24 h-24 text-gray-600 drop-shadow-[0_0_15px_rgba(156,163,175,0.5)]" />;
    };

    return (
        <div className="p-6 h-full flex flex-col items-center justify-center w-full max-w-2xl mx-auto">

            {/* Search Bar */}
            <form onSubmit={handleSearch} className="w-full relative mb-12">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                    <MapPin className="text-accent-blue" size={20} />
                </div>
                <input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="Enter City Name or Zip Code..."
                    className="w-full bg-white border border-gray-300 rounded-2xl py-4 pl-12 pr-16 text-xl text-gray-900 placeholder-gray-600 focus:border-accent-blue focus:shadow-[0_0_30px_var(--color-accent-blue)] transition-all outline-none font-mono"
                />
                <button
                    type="submit"
                    disabled={loading}
                    className="absolute inset-y-2 right-2 px-6 bg-accent-blue/10 hover:bg-accent-blue/20 text-accent-blue rounded-xl transition-all disabled:opacity-50"
                >
                    <Search size={24} />
                </button>
            </form>

            {/* Error */}
            {error && (
                <div className="text-red-500 font-mono mb-8 bg-red-500/10 px-4 py-2 rounded border border-red-500/20">
                    ⚠ {error}
                </div>
            )}

            {/* Weather Card */}
            {weather && (
                <div className="w-full bg-gradient-to-b from-white to-gray-50 border border-gray-200 rounded-3xl p-8 relative overflow-hidden group hover:border-accent-blue/30 transition-all duration-500 shadow-xl">

                    {/* Background glow */}
                    <div className="absolute top-0 right-0 w-64 h-64 bg-accent-blue/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                    <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8">
                        <div className="flex flex-col items-center md:items-start text-center md:text-left">
                            <h2 className="text-4xl font-bold text-gray-900 mb-2 tracking-tight">{weather.name}</h2>
                            <p className="text-accent-blue font-mono text-lg uppercase tracking-widest mb-6">{weather.weather[0].description}</p>

                            <div className="text-7xl font-bold text-transparent bg-clip-text bg-gradient-to-b from-gray-900 to-gray-500">
                                {Math.round(weather.main.temp)}°
                            </div>
                        </div>

                        <div className="flex flex-col items-center">
                            {getWeatherIcon(weather.weather[0].id)}
                        </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4 mt-8 pt-8 border-t border-gray-200">
                        <div className="flex flex-col items-center p-4 bg-gray-100 rounded-2xl">
                            <Wind className="text-gray-600 mb-2" size={20} />
                            <span className="text-lg font-bold text-gray-900">{weather?.wind?.speed || 0}</span>
                            <span className="text-xs text-gray-500 font-mono">km/h</span>
                        </div>
                        <div className="flex flex-col items-center p-4 bg-gray-100 rounded-2xl">
                            <Droplets className="text-blue-400 mb-2" size={20} />
                            <span className="text-lg font-bold text-gray-900">{weather?.main?.humidity || 0}%</span>
                            <span className="text-xs text-gray-500 font-mono">Humidity</span>
                        </div>
                        <div className="flex flex-col items-center p-4 bg-gray-100 rounded-2xl">
                            <Sun className="text-yellow-400 mb-2" size={20} />
                            <span className="text-lg font-bold text-gray-900">
                                {weather?.sys?.sunrise ? `${new Date(weather.sys.sunrise * 1000).getHours()}:${new Date(weather.sys.sunrise * 1000).getMinutes().toString().padStart(2, '0')}` : 'N/A'}
                            </span>
                            <span className="text-xs text-gray-500 font-mono">Sunrise</span>
                        </div>
                    </div>
                </div>
            )}

            {!weather && !loading && !error && (
                <div className="text-gray-600 font-mono text-sm tracking-widest opacity-50">
                    SYSTEM STANDBY. AWAITING COORDINATES.
                </div>
            )}
        </div>
    );
};

export default WeatherControl;
