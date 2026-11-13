import axios from 'axios';

/**
 * Agent Blackboard - A shared communication space for multi-agent systems.
 * Communication via backend filesystem API.
 */
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
const BLACKBOARD_FILE = '../brain/project_blackboard.md';

export const readBlackboard = async () => {
    try {
        const res = await axios.post(`${BACKEND_URL}/api/fs/read`, {
            targetPath: BLACKBOARD_FILE
        });
        return res.data.content || "# Project Blackboard\nNo notes yet.";
    } catch {
        // If file doesn't exist, return empty template
        return "# Project Blackboard\nNo notes yet.";
    }
};

export const updateBlackboard = async (agentName, content) => {
    try {
        // First read existing
        let current = await readBlackboard();
        if (current.includes("No notes yet.")) {
            current = "# Project Blackboard\n";
        }

        const timestamp = new Date().toLocaleString();
        const entry = `\n\n### [${agentName}] - ${timestamp}\n${content}`;
        const newContent = current + entry;

        await axios.post(`${BACKEND_URL}/api/fs/write`, {
            targetPath: BLACKBOARD_FILE,
            content: newContent
        });
        return true;
    } catch (e) {
        console.error("[Blackboard] Write Error:", e);
        return false;
    }
};

export const clearBlackboard = async () => {
    try {
        await axios.post(`${BACKEND_URL}/api/fs/write`, {
            targetPath: BLACKBOARD_FILE,
            content: "# Project Blackboard\n"
        });
        return true;
    } catch {
        return false;
    }
};
