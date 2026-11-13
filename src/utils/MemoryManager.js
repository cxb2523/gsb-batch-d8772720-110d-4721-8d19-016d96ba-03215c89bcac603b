/**
 * MemoryManager - Pure Mem0 Memory Manager with LocalStorage fallback.
 * IndexedDB (MemoryService) has been completely removed as requested.
 */

import { config } from './config';

class Mem0BrowserClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.mem0.ai/v1';
    }

    _getHeaders() {
        return {
            'Authorization': `Token ${this.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    async add(messages, options = {}) {
        const userId = options.user_id || options.userId || "local_user";
        const res = await fetch(`${this.baseUrl}/memories/`, {
            method: 'POST',
            headers: this._getHeaders(),
            body: JSON.stringify({
                messages: messages,
                user_id: userId,
                metadata: options.metadata || {}
            })
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Mem0 Cloud Add Failed (${res.status}): ${errText}`);
        }
        return await res.json();
    }

    async search(query, options = {}) {
        const userId = options.filters?.user_id || options.user_id || options.userId || "local_user";
        const topK = options.topK || options.top_k || 5;

        const res = await fetch(`${this.baseUrl}/memories/search/`, {
            method: 'POST',
            headers: this._getHeaders(),
            body: JSON.stringify({
                query: query,
                user_id: userId,
                filters: { user_id: userId },
                top_k: topK
            })
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Mem0 Cloud Search Failed (${res.status}): ${errText}`);
        }
        const data = await res.json();
        return Array.isArray(data) ? { results: data } : data;
    }

    async getAll(options = {}) {
        const userId = options.filters?.user_id || options.user_id || options.userId || "local_user";
        const res = await fetch(`${this.baseUrl}/memories/?user_id=${encodeURIComponent(userId)}`, {
            method: 'GET',
            headers: this._getHeaders()
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Mem0 Cloud GetAll Failed (${res.status}): ${errText}`);
        }
        const data = await res.json();
        return Array.isArray(data) ? { results: data } : data;
    }

    async delete(memoryId) {
        const res = await fetch(`${this.baseUrl}/memories/${memoryId}/`, {
            method: 'DELETE',
            headers: this._getHeaders()
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Mem0 Cloud Delete Failed (${res.status}): ${errText}`);
        }
        return await res.json();
    }

    async deleteAll(options = {}) {
        const userId = options.user_id || options.userId || "local_user";
        const res = await fetch(`${this.baseUrl}/memories/?user_id=${encodeURIComponent(userId)}`, {
            method: 'DELETE',
            headers: this._getHeaders()
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Mem0 Cloud DeleteAll Failed (${res.status}): ${errText}`);
        }
        return await res.json();
    }
}

class MemoryManager {
    constructor() {
        this.client = null;
        this.currentApiKey = null;
        console.log(`[MemoryManager] Mem0 Engine Active (IndexedDB removed).`);
    }

    getMem0Client() {
        const apiKey = config.getApiKey('VITE_MEM0_API_KEY');
        if (!apiKey) {
            this.client = null;
            this.currentApiKey = null;
            return null;
        }

        if (!this.client || this.currentApiKey !== apiKey) {
            try {
                this.client = new Mem0BrowserClient(apiKey);
                this.currentApiKey = apiKey;
                console.log('[MemoryManager] Mem0 Browser Client active.');
            } catch (e) {
                console.error('[MemoryManager] Failed to initialize Mem0 Client:', e);
                this.client = null;
            }
        }
        return this.client;
    }

    isCloudActive() {
        return Boolean(this.getMem0Client());
    }

    isConfigured() {
        return true;
    }

    _getLocalMemories() {
        try {
            const data = localStorage.getItem('LIYA_LOCAL_MEMORIES');
            return data ? JSON.parse(data) : [];
        } catch {
            return [];
        }
    }

    _saveLocalMemories(memories) {
        try {
            localStorage.setItem('LIYA_LOCAL_MEMORIES', JSON.stringify(memories.slice(0, 200)));
        } catch (e) {
            console.error('[MemoryManager] Failed to save to localStorage:', e);
        }
    }

    _normalizeMessages(messagesOrText) {
        if (!messagesOrText) return [];
        if (typeof messagesOrText === 'string') {
            return [{ role: 'user', content: messagesOrText.trim() }];
        }
        if (Array.isArray(messagesOrText)) {
            return messagesOrText
                .map(msg => {
                    if (typeof msg === 'string') return { role: 'user', content: msg.trim() };
                    if (msg && msg.content) return { role: msg.role || 'user', content: String(msg.content).trim() };
                    return null;
                })
                .filter(Boolean);
        }
        return [];
    }

    async add(messagesOrText, metadata = {}) {
        const messages = this._normalizeMessages(messagesOrText);
        if (messages.length === 0) return null;

        const userId = config.getUserName() || "local_user";
        const mem0Client = this.getMem0Client();

        if (mem0Client) {
            try {
                console.log('[MemoryManager] Adding memories to Mem0 Cloud for user:', userId);
                const cloudRes = await mem0Client.add(messages, {
                    user_id: userId,
                    metadata
                });
                return { message: "Saved to Mem0 Cloud", data: cloudRes };
            } catch (e) {
                console.warn('[MemoryManager] Mem0 Cloud add error, falling back to localStorage:', e.message || e);
            }
        }

        // Local Storage Fallback (IndexedDB Completely Removed)
        try {
            const localMems = this._getLocalMemories();
            for (const msg of messages) {
                if (msg.content) {
                    localMems.unshift({
                        id: Date.now() + Math.random(),
                        content: msg.content,
                        userId,
                        timestamp: Date.now()
                    });
                }
            }
            this._saveLocalMemories(localMems);
            return { message: "Saved to localStorage" };
        } catch (e) {
            console.error('[MemoryManager] Local Storage Add Error:', e);
            return null;
        }
    }

    async search(query, limit = 5) {
        if (!query || !query.trim()) return null;

        const userId = config.getUserName() || "local_user";
        const mem0Client = this.getMem0Client();

        const lowerQ = query.toLowerCase();
        const isAboutUserQuery = /about me|apne baare|mere baare|who am i|mera naam|my info|my memory|kya jaante/i.test(lowerQ);
        const searchQuery = isAboutUserQuery ? `${userId} ${query}` : query;

        if (mem0Client) {
            try {
                console.log('[MemoryManager] Searching Mem0 Cloud memories:', searchQuery);
                let response = await mem0Client.search(searchQuery, {
                    filters: { user_id: userId },
                    topK: limit
                });

                let results = response?.results || (Array.isArray(response) ? response : []);

                // If broad 'about user' query returned no results from vector search, fallback to getAll()
                if (results.length === 0 && isAboutUserQuery) {
                    console.log('[MemoryManager] Broad user query returned 0 search results, fetching all memories...');
                    const allMems = await mem0Client.getAll({ user_id: userId });
                    results = allMems?.results || (Array.isArray(allMems) ? allMems : []);
                }

                if (results.length > 0) {
                    const formatted = results
                        .map(item => item.memory || item.content || item.text)
                        .filter(Boolean)
                        .slice(0, limit)
                        .join('\n- ');
                    return formatted ? `- ${formatted}` : null;
                }
            } catch (e) {
                console.warn('[MemoryManager] Mem0 Cloud search error, falling back to localStorage:', e.message || e);
            }
        }

        // Local Storage Fallback (IndexedDB Completely Removed)
        try {
            const localMems = this._getLocalMemories();
            const lowerQuery = query.toLowerCase();
            const filtered = localMems.filter(m => m.content.toLowerCase().includes(lowerQuery));
            if (filtered.length > 0) {
                const limitedResults = filtered.slice(0, limit);
                const formatted = limitedResults.map(m => m.content).join('\n- ');
                return `- ${formatted}`;
            }
            return null;
        } catch (e) {
            console.error('[MemoryManager] Local Search Error:', e);
            return null;
        }
    }

    async getAll() {
        const userId = config.getUserName() || "local_user";
        const mem0Client = this.getMem0Client();

        if (mem0Client) {
            try {
                const cloudMemories = await mem0Client.getAll({ filters: { user_id: userId }, user_id: userId });
                const results = cloudMemories?.results || (Array.isArray(cloudMemories) ? cloudMemories : []);
                if (results.length > 0) return results;
            } catch (e) {
                console.warn('[MemoryManager] Mem0 Cloud getAll error, falling back to localStorage:', e.message || e);
            }
        }

        return this._getLocalMemories();
    }

    async delete(memoryId) {
        const mem0Client = this.getMem0Client();
        if (mem0Client) {
            try {
                await mem0Client.delete(memoryId);
            } catch (e) {
                console.warn('[MemoryManager] Mem0 Cloud delete error:', e.message || e);
            }
        }

        const localMems = this._getLocalMemories();
        const updated = localMems.filter(m => String(m.id) !== String(memoryId));
        this._saveLocalMemories(updated);
        return true;
    }

    async clearAll() {
        const userId = config.getUserName() || "local_user";
        const mem0Client = this.getMem0Client();

        if (mem0Client) {
            try {
                await mem0Client.deleteAll({ user_id: userId, userId });
            } catch (e) {
                console.warn('[MemoryManager] Mem0 Cloud clearAll error:', e.message || e);
            }
        }

        localStorage.removeItem('LIYA_LOCAL_MEMORIES');
        return true;
    }
}

export const memoryManager = new MemoryManager();
export default MemoryManager;
