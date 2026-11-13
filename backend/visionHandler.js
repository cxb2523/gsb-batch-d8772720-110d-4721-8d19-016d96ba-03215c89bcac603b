const { Ollama } = require('ollama');

/**
 * Analyzes a base64 image using Ollama Cloud
 */
async function analyzeSnapshot(base64Data, prompt = "Analyze this UI snapshot and describe what you see.", retries = 3) {
    // 1. TRY OLLAMA CLOUD FIRST
    try {
        const { getBackendApiKey } = require('./configHelper');
        const apiKey = getBackendApiKey('VITE_OLLAMA_CLOUD_API_KEY');
        const modelName = process.env.VISION_MODEL || 'qwen3-vl:235b-cloud';

        if (apiKey) {
            const ollama = new Ollama({
                host: 'https://api.ollama.com',
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            console.log(`[Vision] Attempting Ollama Cloud analysis (${modelName})...`);
            
            const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");

            const response = await ollama.chat({
                model: modelName,
                messages: [{
                    role: 'user',
                    content: prompt,
                    images: [cleanBase64]
                }],
                stream: false
            });

            if (response && response.message) {
                console.log("[Vision] Ollama Cloud Success.");
                return response.message.content;
            }
        }
    } catch (ollamaError) {
        console.error(`[Vision] Ollama Cloud Error:`, ollamaError.message);
        throw ollamaError;
    }
    
    throw new Error("Ollama Cloud analysis failed (No response)");
}

module.exports = { analyzeSnapshot };
