/**
 * Ultra-Low Latency Indian Accent Neural Voice Engine for J.A.R.V.I.S.
 * Converts Hinglish/English text into natural Devanagari Indian accent TTS using edge-tts.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

// Common Hinglish to Devanagari Phonetic Map for Natural Indian Accent Pronunciation
const HINGLISH_MAP = {
    "namaste": "नमस्ते",
    "kaise": "कैसे",
    "ho": "हो",
    "sir": "सर",
    "main": "मैं",
    "bilkul": "बिल्कुल",
    "theek": "ठीक",
    "hoon": "हूँ",
    "aap": "आप",
    "aapka": "आपका",
    "kya": "क्या",
    "karo": "करो",
    "bataiye": "बताइए",
    "batao": "बताओ",
    "aaj": "आज",
    "ha": "हाँ",
    "haan": "हाँ",
    "nahi": "नहीं",
    "kar": "कर",
    "raha": "रहा",
    "rahi": "रही",
    "ji": "जी",
    "chahte": "चाहते",
    "samajh": "समझ",
    "gaya": "गया",
    "gayi": "गयी",
    "shuru": "शुरू",
    "dost": "दोस्त",
    "dhanyawad": "धन्यवाद",
    "shukriya": "शुक्रिया"
};

/**
 * Transliterate Hinglish words to Devanagari script for natural Indian intonation
 */
function hinglishToDevanagari(text) {
    if (!text) return '';
    // If text already contains Devanagari Hindi characters, keep as is
    if (/[\u0900-\u097F]/.test(text)) return text;

    let words = text.split(/\s+/);
    let convertedWords = words.map(word => {
        let cleanWord = word.toLowerCase().replace(/[^a-z]/g, '');
        if (HINGLISH_MAP[cleanWord]) {
            return word.toLowerCase().replace(cleanWord, HINGLISH_MAP[cleanWord]);
        }
        return word;
    });

    return convertedWords.join(' ');
}

class IndianAccentVoiceEngine {
    constructor() {
        this.voice = 'hi-IN-SwaraNeural'; // Permanent Default: Warm, Soft & Natural Female Hindi Neural Voice
    }

    /**
     * Synthesize high quality Indian accent speech with minimum latency (< 300ms)
     */
    async synthesizeSpeech(text, voiceName) {
        if (!text || !text.trim()) return null;

        const selectedVoice = voiceName || this.voice;
        const devanagariText = hinglishToDevanagari(text.trim());

        const tempFile = path.resolve(__dirname, `../scratch/indian_tts_${Date.now()}.mp3`);
        await fs.ensureDir(path.dirname(tempFile));

        const cleanText = devanagariText.replace(/["'\\]/g, ' ').replace(/\s+/g, ' ').trim();

        return new Promise((resolve, reject) => {
            const child = spawn('edge-tts', [
                '--voice', selectedVoice,
                '--text', cleanText,
                '--write-media', tempFile,
                '--rate=+18%',
                '--pitch=-1Hz'
            ]);

            child.on('close', async (code) => {
                if (code === 0 && (await fs.pathExists(tempFile))) {
                    resolve(tempFile);
                } else {
                    reject(new Error(`edge-tts exited with code ${code}`));
                }
            });

            child.on('error', (err) => {
                reject(err);
            });
        });
    }
}

const engine = new IndianAccentVoiceEngine();

module.exports = {
    indianVoiceEngine: engine,
    hinglishToDevanagari
};
