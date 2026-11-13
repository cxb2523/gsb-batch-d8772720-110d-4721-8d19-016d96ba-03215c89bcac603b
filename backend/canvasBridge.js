/**
 * Canvas Bridge for Backend-to-Frontend Sync
 * Allows Backend tools to push events to the Desktop UI
 */
const os = require('os');
const { exec } = require('child_process');

let ioInstance = null;
let currentState = {
    blocks: [],
    isVisible: false,
    mode: 'feed', // 'feed' | 'dashboard'
    lastUpdate: Date.now()
};

function initCanvasBridge(io) {
    ioInstance = io;
}

/**
 * Push a new UI block to the Desktop Canvas
 */
function pushToCanvas(block, append = true) {
    if (!ioInstance) return;

    // Helper to find existing specialized blocks
    const youtubeBlock = currentState.blocks.find(b => b.id === 'youtube_player');

    const pushSingle = (b) => {
        // [PERF] If we're pushing a map, remove any other existing maps first 
        // to prevent DOM bloat and performance "hanging".
        if (b.type === 'map') {
            currentState.blocks = currentState.blocks.filter(existing => existing.type !== 'map');
        }

        const existingIndex = currentState.blocks.findIndex(existing => existing.id === b.id);
        if (existingIndex !== -1) {
            currentState.blocks[existingIndex] = b;
        } else {
            currentState.blocks.push(b);
        }
    };

    if (Array.isArray(block)) {
        if (!append) {
            currentState.blocks = youtubeBlock ? [youtubeBlock] : [];
        }
        block.forEach(pushSingle);
        console.log(`[CanvasBridge] Pushed/Updated ${block.length} blocks.`);
    } else {
        // If append=false, clear everything except the YouTube player (to keep music/video playing)
        if (!append) {
            currentState.blocks = youtubeBlock && block.id !== 'youtube_player' 
                ? [youtubeBlock, block] 
                : [block];
        } else {
            pushSingle(block);
        }
        console.log(`[CanvasBridge] Pushed/Updated block: ${block.type} (ID: ${block.id})`);
    }
    
    currentState.isVisible = true;
    currentState.lastUpdate = Date.now();

    ioInstance.emit('canvas-update', currentState);
}

/**
 * Notify Desktop of a Backend event
 */
function notifyDesktop(title, message, type = 'info') {
    pushToCanvas({
        id: `back_${Date.now()}`,
        type: 'text',
        title: `🖥️ Backend: ${title}`,
        content: message,
        variant: type // 'info', 'success', 'warning'
    });
}

/**
 * Push a message directly into the active desktop chat
 */
function pushToChat(content, role = 'assistant') {
    if (!ioInstance) return;
    ioInstance.emit('chat-message', { role, content, timestamp: Date.now() });
    console.log(`[CanvasBridge] Pushed chat message: ${content.slice(0, 30)}...`);
}

function getCanvasState() {
    return currentState;
}

function setCanvasState(newState) {
    currentState = newState;
    if (ioInstance) ioInstance.emit('canvas-update', currentState);
}

/**
 * Delete a specific block by ID
 */
function deleteBlock(blockId) {
    const before = currentState.blocks.length;
    currentState.blocks = currentState.blocks.filter(b => (b.id || `block-${currentState.blocks.indexOf(b)}`) !== blockId);
    currentState.lastUpdate = Date.now();
    if (ioInstance) ioInstance.emit('canvas-update', currentState);
    console.log(`[CanvasBridge] Deleted block: ${blockId} (${before} -> ${currentState.blocks.length})`);
    return currentState.blocks.length < before;
}

/**
 * Toggle pin status on a block
 */
function pinBlock(blockId) {
    const block = currentState.blocks.find(b => b.id === blockId);
    if (!block) return false;
    block.pinned = !block.pinned;
    block.pinnedAt = block.pinned ? Date.now() : null;
    currentState.lastUpdate = Date.now();
    if (ioInstance) ioInstance.emit('canvas-update', currentState);
    console.log(`[CanvasBridge] ${block.pinned ? 'Pinned' : 'Unpinned'} block: ${blockId}`);
    return block.pinned;
}

/**
 * Reorder blocks by an array of IDs
 */
function reorderBlocks(orderedIds) {
    const blockMap = new Map(currentState.blocks.map(b => [b.id, b]));
    const reordered = [];
    for (const id of orderedIds) {
        if (blockMap.has(id)) {
            reordered.push(blockMap.get(id));
            blockMap.delete(id);
        }
    }
    // Append any blocks not in the ordered list (safety net)
    for (const remaining of blockMap.values()) {
        reordered.push(remaining);
    }
    currentState.blocks = reordered;
    currentState.lastUpdate = Date.now();
    if (ioInstance) ioInstance.emit('canvas-update', currentState);
    console.log(`[CanvasBridge] Reordered ${reordered.length} blocks.`);
    return true;
}

/**
 * Get real-time system stats (CPU, RAM, Uptime, Latency)
 */
async function getSystemStats() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = Math.round((usedMem / totalMem) * 100);

    // CPU Usage: Use wmic for Windows to get actual load
    let cpuUsage = 0;
    try {
        if (os.platform() === 'win32') {
            const cpuData = await new Promise((resolve) => {
                exec('wmic cpu get loadpercentage', (err, stdout) => {
                    if (err) resolve("15");
                    const lines = stdout.trim().split('\n');
                    resolve(lines[1]?.trim() || "15");
                });
            });
            cpuUsage = parseInt(cpuData);
        } else {
            cpuUsage = Math.round(os.loadavg()[0] * 10);
        }
    } catch (e) {
        cpuUsage = 15;
    }

    // Real-time Latency (Ping to 8.8.8.8)
    let latency = 45;
    try {
        const start = Date.now();
        await axios.get('https://8.8.8.8', { timeout: 1000 }).catch(() => {});
        latency = Date.now() - start;
    } catch (e) {
        latency = 45;
    }

    const uptime = Math.floor(os.uptime() / 3600);

    return {
        cpu: cpuUsage > 100 ? 99 : cpuUsage,
        ram: memUsage,
        uptime: `${uptime}h`,
        latency: latency,
        platform: os.platform(),
        timestamp: Date.now()
    };
}

// Stats Heartbeat (Push every 3 seconds if active)
setInterval(async () => {
    if (ioInstance) {
        const stats = await getSystemStats();
        ioInstance.emit('system-stats', stats);
    }
}, 3000);

module.exports = { 
    initCanvasBridge, 
    pushToCanvas, 
    notifyDesktop, 
    pushToChat, 
    getCanvasState, 
    setCanvasState,
    getSystemStats,
    deleteBlock,
    pinBlock,
    reorderBlocks
};
