import { getDynamicSinricConfig } from './homeConfig.js';

/**
 * Control a Sinric Pro Device
 * @param {string} deviceName - The name of the device (e.g., "light", "fan")
 * @param {boolean} turnOn - True to turn ON, False to turn OFF
 * @returns {Promise<string>} - Result message
 */
export const toggleDevice = async (deviceName, turnOn) => {
    const config = getDynamicSinricConfig();
    const deviceId = config.devices[deviceName.toLowerCase()];

    if (!deviceId) {
        console.warn(`Device '${deviceName}' not found in configuration.`);
        return `Device "${deviceName}" not recognized. Please check config.`;
    }

    const value = turnOn ? 'On' : 'Off';

    const action = 'setPowerState';
    const payload = {
        action: action,
        value: {
            state: value
        },
        clientId: "liya-web",
        type: "request"
    };

    console.log(`[Home Automation] Sending command to ${deviceName} (${deviceId}): ${value}`);

    try {
        const baseUrl = import.meta.env.VITE_BACKEND_URL || '';
        const response = await fetch(`${baseUrl}/sinric/api/v1/devices/${deviceId}/action`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-sinric-api-key': config.apiKey
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.success) {
            return `Successfully turned ${value.toUpperCase()} the ${deviceName}.`;
        } else {
            console.error('[Home Automation] API Error:', data);
            return `Failed to control ${deviceName}. [Sinric API Error: ${data.message || 'Unknown error'}]`;
        }
    } catch (error) {
        console.error('[Home Automation] Network Error:', error);
        return `Network Error: Could not connect to Sinric Pro to control ${deviceName}.`;
    }
};

/**
 * Get current state of a device
 * @param {string} deviceName 
 * @returns {Promise<boolean>} - true if ON, false if OFF
 */
export const getDeviceState = async (deviceName) => {
    const config = getDynamicSinricConfig();
    const deviceId = config?.devices?.[deviceName.toLowerCase()];
    if (!deviceId) return false;

    // Sinric Pro REST API is action-oriented only.
    // Real-time device state polling is not available via REST.
    // Returning false as default (last known = unknown).
    return false;
};
