/**
 * useChatSocket.js — Custom React Hook for Secure Chat
 * 
 * Handles socket connection (/chat namespace), authentication,
 * message sending/receiving, presence, typing, and AES-256-GCM encryption.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

// ─── AES-256-GCM Encryption Helpers (Web Crypto API) ─────────────────

async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptMessage(text, roomKey) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltStr = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
    const key = await deriveKey(roomKey, saltStr);
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        enc.encode(text)
    );
    return {
        content: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, '0')).join(''),
        iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''),
        salt: saltStr
    };
}

async function decryptMessage(contentHex, ivHex, saltStr, roomKey) {
    try {
        const key = await deriveKey(roomKey, saltStr);
        const iv = new Uint8Array(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));
        const data = new Uint8Array(contentHex.match(/.{2}/g).map(b => parseInt(b, 16)));
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            data
        );
        return new TextDecoder().decode(decrypted);
    } catch {
        return '[🔒 Encrypted — cannot decrypt]';
    }
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useChatSocket() {
    const [socket, setSocket] = useState(null);
    const [connected, setConnected] = useState(false);
    const [currentUser, setCurrentUser] = useState(null);
    const [onlineUsers, setOnlineUsers] = useState({});
    const [activeRoom, setActiveRoom] = useState(null);
    const [messages, setMessages] = useState([]);
    const [typingUsers, setTypingUsers] = useState({});
    const [groupRooms, setGroupRooms] = useState({});
    const [tunnelUrl, setTunnelUrl] = useState(null);
    const [error, setError] = useState(null);

    const roomKeyRef = useRef('liya-secure-chat-default-key'); // Shared room key
    const typingTimeoutsRef = useRef({});
    const activeRoomRef = useRef(null);

    // Keep activeRoomRef in sync
    useEffect(() => {
        activeRoomRef.current = activeRoom;
    }, [activeRoom]);

    // ── Connect Socket ───────────────────────────────────────────────
    useEffect(() => {
        const s = io(`${BACKEND_URL}/chat`, {
            transports: ['polling', 'websocket'],
            reconnectionAttempts: 10,
            reconnectionDelay: 2000,
            timeout: 20000,
            withCredentials: true
        });

        s.on('connect', () => {
            console.log('[Chat] Connected to /chat namespace');
            setConnected(true);
        });

        s.on('disconnect', () => {
            console.log('[Chat] Disconnected');
            setConnected(false);
        });

        s.on('connect_error', (err) => {
            console.warn('[Chat] Connection error:', err.message);
        });

        // Listen for user list updates
        s.on('chat:users', (users) => {
            setOnlineUsers(users);
        });

        // Listen for messages
        s.on('chat:message', async (msg) => {
            // Decrypt the message
            let plaintext;
            if (msg.iv && msg.salt) {
                plaintext = await decryptMessage(msg.content, msg.iv, msg.salt, roomKeyRef.current);
            } else {
                plaintext = msg.content;
            }

            const decryptedMsg = { ...msg, plaintext };

            setMessages(prev => {
                // Avoid duplicates
                if (prev.find(m => m.id === msg.id)) return prev;
                return [...prev, decryptedMsg];
            });
        });

        // Listen for typing
        s.on('chat:typing', (data) => {
            if (data.room === activeRoomRef.current) {
                setTypingUsers(prev => ({ ...prev, [data.userId]: data.username }));

                // Clear after 3 seconds
                if (typingTimeoutsRef.current[data.userId]) {
                    clearTimeout(typingTimeoutsRef.current[data.userId]);
                }
                typingTimeoutsRef.current[data.userId] = setTimeout(() => {
                    setTypingUsers(prev => {
                        const next = { ...prev };
                        delete next[data.userId];
                        return next;
                    });
                }, 3000);
            }
        });

        // Listen for group rooms
        s.on('chat:rooms', (rooms) => {
            setGroupRooms(rooms);
        });

        // Listen for presence changes
        s.on('chat:presence', (data) => {
            // Already handled via chat:users, but can use for notifications
        });

        setSocket(s);

        // Fetch tunnel URL
        fetch(`${BACKEND_URL}/api/chat/tunnel-url`)
            .then(r => r.json())
            .then(d => setTunnelUrl(d.url))
            .catch(() => {});

        // Poll tunnel URL every 10 seconds until we get one
        const tunnelPoll = setInterval(() => {
            fetch(`${BACKEND_URL}/api/chat/tunnel-url`)
                .then(r => r.json())
                .then(d => {
                    if (d.url && d.url !== 'Connecting...') {
                        setTunnelUrl(d.url);
                        clearInterval(tunnelPoll);
                    }
                })
                .catch(() => {});
        }, 10000);

        return () => {
            s.disconnect();
            clearInterval(tunnelPoll);
        };
    }, []);

    // ── Register ─────────────────────────────────────────────────────
    const register = useCallback((username, password) => {
        return new Promise((resolve) => {
            if (!socket) return resolve({ success: false, error: 'Not connected' });
            socket.emit('chat:register', { username, password }, (res) => {
                if (res.success) {
                    setCurrentUser(res.user);
                    setError(null);
                } else {
                    setError(res.error);
                }
                resolve(res);
            });
        });
    }, [socket]);

    // ── Login ────────────────────────────────────────────────────────
    const login = useCallback((username, password) => {
        return new Promise((resolve) => {
            if (!socket) return resolve({ success: false, error: 'Not connected' });
            socket.emit('chat:login', { username, password }, (res) => {
                if (res.success) {
                    setCurrentUser(res.user);
                    setError(null);
                } else {
                    setError(res.error);
                }
                resolve(res);
            });
        });
    }, [socket]);

    // ── Join Room ────────────────────────────────────────────────────
    const joinRoom = useCallback(async (targetUserId = null, roomName = null, type = 'p2p') => {
        return new Promise((resolve) => {
            if (!socket) return resolve({ success: false });
            socket.emit('chat:join-room', { targetUserId, roomName, type }, async (res) => {
                if (res.success) {
                    setActiveRoom(res.room);
                    // Decrypt history
                    const decrypted = [];
                    for (const msg of (res.messages || [])) {
                        let plaintext;
                        if (msg.iv && msg.salt) {
                            plaintext = await decryptMessage(msg.content, msg.iv, msg.salt, roomKeyRef.current);
                        } else {
                            plaintext = msg.content;
                        }
                        decrypted.push({ ...msg, plaintext });
                    }
                    setMessages(decrypted);
                }
                resolve(res);
            });
        });
    }, [socket]);

    // ── Send Message ─────────────────────────────────────────────────
    const sendMessage = useCallback(async (text) => {
        if (!socket || !activeRoom || !text.trim()) return;

        const encrypted = await encryptMessage(text, roomKeyRef.current);
        socket.emit('chat:message', {
            to: activeRoom,
            content: encrypted.content,
            iv: encrypted.iv,
            salt: encrypted.salt
        });
    }, [socket, activeRoom]);

    // ── Send Typing ──────────────────────────────────────────────────
    const sendTyping = useCallback(() => {
        if (!socket || !activeRoom) return;
        socket.emit('chat:typing', { room: activeRoom });
    }, [socket, activeRoom]);

    // ── Logout ───────────────────────────────────────────────────────
    const logout = useCallback(() => {
        setCurrentUser(null);
        setActiveRoom(null);
        setMessages([]);
        setTypingUsers({});
        setError(null);
    }, []);

    return {
        connected,
        currentUser,
        onlineUsers,
        activeRoom,
        messages,
        typingUsers,
        groupRooms,
        tunnelUrl,
        error,
        register,
        login,
        logout,
        joinRoom,
        sendMessage,
        sendTyping,
        setActiveRoom,
        setError
    };
}
