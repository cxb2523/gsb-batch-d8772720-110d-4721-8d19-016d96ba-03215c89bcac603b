import { io } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

let socketInstance = null;

export const getSocket = () => {
    if (!socketInstance) {
        console.log("🔌 Initializing Global Socket Instance");
        socketInstance = io(BACKEND_URL, {
            transports: ['polling', 'websocket'], // Start with polling, upgrade to websocket
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            timeout: 20000,
            withCredentials: true
        });

        socketInstance.on('connect_error', (err) => {
            console.warn("🔌 Socket Connection Error:", err.message);
        });
    }
    return socketInstance;
};
