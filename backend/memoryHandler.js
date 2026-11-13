const fs = require('fs-extra');
const path = require('path');

const MEMORIES_FILE = path.resolve(__dirname, '../brain/memories.json');

async function ensureMemoriesFile() {
    await fs.ensureDir(path.dirname(MEMORIES_FILE));
    if (!await fs.pathExists(MEMORIES_FILE)) {
        await fs.writeJson(MEMORIES_FILE, []);
    }
}

async function searchMemories(query, userId = null, limit = 3) {
    try {
        await ensureMemoriesFile();
        const memories = await fs.readJson(MEMORIES_FILE);
        const lowerQuery = query.toLowerCase();
        
        // Filter memories matching query and optionally userId
        const matched = memories.filter(m => {
            const matchesQuery = m.content.toLowerCase().includes(lowerQuery) || 
                                 (m.tags && m.tags.some(t => t.toLowerCase().includes(lowerQuery)));
            const matchesUser = userId ? m.userId === userId : true;
            return matchesQuery && matchesUser;
        });

        // Sort by timestamp descending (newest first)
        matched.sort((a, b) => b.timestamp - a.timestamp);

        if (matched.length > 0) {
            return matched.slice(0, limit).map(m => m.content).join('\n- ');
        }
        return null;
    } catch (error) {
        console.error("[MemoryHandler] Search Error:", error.message);
        return null;
    }
}

async function addMemory(messages, userId = null) {
    try {
        await ensureMemoriesFile();
        const memories = await fs.readJson(MEMORIES_FILE);
        const addedMems = [];

        const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: messages }];

        for (const msg of msgs) {
            if (msg.content && msg.content.trim()) {
                const mem = {
                    id: 'mem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                    content: msg.content,
                    userId: userId || "local_user",
                    timestamp: Date.now(),
                    tags: []
                };
                memories.push(mem);
                addedMems.push(mem);
            }
        }

        await fs.writeJson(MEMORIES_FILE, memories, { spaces: 2 });
        console.log(`[MemoryHandler] Added ${addedMems.length} memory entries locally.`);
        return addedMems;
    } catch (error) {
        console.error("[MemoryHandler] Add Error:", error.message);
        return null;
    }
}

module.exports = { searchMemories, addMemory };
