/**
 * config.js
 * Centralized configuration for User Identity and App Branding.
 * Priority: localStorage > .env > Default
 */

const getStorageItem = (key, fallback) => {
    try {
        return localStorage.getItem(key) || fallback;
    } catch {
        return fallback;
    }
};

export const config = {
    getUserName: () => getStorageItem('LIYA_MASTER_NAME', getStorageItem('VITE_USER_NAME', import.meta.env.VITE_USER_NAME || "Master")),
    getAppName: () => "LIYA",
    getCreatorName: () => "Navraj",

    setUserName: (name) => localStorage.setItem('LIYA_MASTER_NAME', name),

    // API Keys management helper
    getApiKey: (key) => {
        if (key === 'VITE_OLLAMA_CLOUD_API_KEY') {
            const stored = getStorageItem(key, null);
            if (stored) return stored;
            const legacyStored = getStorageItem('OLLAMA_CLOUD_API_KEY', null);
            if (legacyStored) return legacyStored;
            return import.meta.env.VITE_OLLAMA_CLOUD_API_KEY || "";
        }
        const value = getStorageItem(key, null);
        if (value) return value;
        // Fallback for non-VITE prefixed version
        const legacyKey = key.replace('VITE_', '');
        const legacyVal = getStorageItem(legacyKey, null);
        if (legacyVal) return legacyVal;
        return import.meta.env[key] || "";
    },
    setApiKey: (key, value) => {
        localStorage.setItem(key, value);
        // Also sync non-VITE version for legacy compatibility
        localStorage.setItem(key.replace('VITE_', ''), value);
    }
};
