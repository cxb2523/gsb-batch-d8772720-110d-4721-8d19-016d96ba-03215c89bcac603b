/**
 * Home Automation Configuration (Dynamic Hub)
 * This utility handles both hardcoded environment variables and 
 * user-defined settings from the UI (LocalStorage).
 */

export const getDynamicSinricConfig = () => {
    // 1. Fetch Credentials
    const apiKey = localStorage.getItem('SINRIC_API_KEY') || import.meta.env.VITE_SINRIC_API_KEY || "";

    // 2. Fetch Devices (Supports 5 Slots)
    let devices = {};
    const storedDevices = localStorage.getItem('SINRIC_DEVICES');

    if (storedDevices) {
        try {
            const parsed = JSON.parse(storedDevices);
            // Map the parsed [ {id, name}, ... ] into a lookup object
            parsed.forEach(dev => {
                if (dev.id && dev.name) {
                    devices[dev.name.toLowerCase()] = dev.id;
                }
            });
        } catch (e) {
            console.error("Failed to parse stored Sinric devices:", e);
        }
    }

    // 3. System Fallbacks (If no user-defined devices exist, use defaults)
    if (Object.keys(devices).length === 0) {
        devices = {
            "pannel light": import.meta.env.VITE_SINRIC_DEVICE_PANEL_LIGHT || "",
            "star light": import.meta.env.VITE_SINRIC_DEVICE_STAR_LIGHT || "",
            "tv": import.meta.env.VITE_SINRIC_DEVICE_TV || "",
            "light": import.meta.env.VITE_SINRIC_DEVICE_PANEL_LIGHT || ""
        };
    }

    return { apiKey, devices };
};

// Legacy object for backward compatibility during transition
export const SINRIC_CONFIG = getDynamicSinricConfig();
