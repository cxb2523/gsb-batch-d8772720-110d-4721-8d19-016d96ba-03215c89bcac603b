export const getVoices = () => {
    return new Promise((resolve) => {
        let voices = window.speechSynthesis.getVoices();
        if (voices.length) {
            resolve(voices);
            return;
        }
        let resolved = false;
        window.speechSynthesis.onvoiceschanged = () => {
            if (resolved) return;
            resolved = true;
            voices = window.speechSynthesis.getVoices();
            resolve(voices);
        };
        // Timeout fallback — prevent hanging if onvoiceschanged never fires
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(window.speechSynthesis.getVoices());
            }
        }, 3000);
    });
};

export const cleanTextForSpeech = (text) => {
    if (!text) return "";

    // 1. Remove [CHART_DATA: ...] blocks
    let clean = text.replace(/\[CHART_DATA:[\s\S]*?\]/g, "");

    // 2. Remove Thought Process and System blocks
    clean = clean.replace(/<THOUGHT_PROCESS>[\s\S]*?<\/THOUGHT_PROCESS>/gi, "");
    clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, "");
    clean = clean.replace(/\[INTERNAL_PLAN:[\s\S]*?\]/gi, "");
    clean = clean.replace(/\[\[.*?\]\]/g, ""); 

    // 3. Remove Code Blocks (```...```)
    clean = clean.replace(/```[\s\S]*?```/g, " Here is the detailed code. ");

    // 4. Remove Tables
    clean = clean.replace(/^\|.*\|$/gm, "");
    clean = clean.replace(/^\s*[-:| ]+\s*$/gm, "");

    // 5. Remove Inline Code (`)
    clean = clean.replace(/`([^`]+)`/g, "$1");

    // 6. Remove Markdown Links [Text](URL)
    clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

    // 7. Remove Headers (#), Bold (**), Italic (*)
    clean = clean.replace(/[#*]/g, "");

    // 8. Remove HTML tags
    clean = clean.replace(/<\/?[^>]+(>|$)/g, "");

    // 9. Remove Emojis
    clean = clean.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "");

    // 11. Remove Internal Reasoning & Task Updates
    clean = clean.replace(/The user wants to[\s\S]*?\./gi, "");
    clean = clean.replace(/Automated task [\s\S]*? completed\./gi, "");
    clean = clean.replace(/Background task for [\s\S]*? started\./gi, "");
    clean = clean.replace(/\[SYSTEM_NOTIFICATION:[\s\S]*?\]/gi, "");

    // 12. Clean excessive whitespace
    clean = clean.replace(/\s+/g, " ").trim();

    return clean;
};

export const speakBrowser = async (text, voiceName = null, onEndCallback = null, onStartCallback = null, queueSupport = false) => {
    const synth = window.speechSynthesis;

    if (synth.speaking && !queueSupport) {
        synth.cancel();
    }

    const cleaned = cleanTextForSpeech(text);
    if (!cleaned || cleaned.trim().length === 0) {
        onEndCallback?.();
        return;
    }

    const chunks = cleaned.match(/[^.!?]+[.!?]*|[^.!?]+/g) || [cleaned];
    let voices = synth.getVoices();
    if (voices.length === 0) voices = await getVoices();

    let selectedVoice = null;
    // User-specified voice name takes priority
    if (voiceName) selectedVoice = voices.find(v => v.name === voiceName);
    
    // Priority list for Indian English / Hindi voices
    if (!selectedVoice) {
        const voicePriority = [
            v => v.name.includes('Neerja'),                    // Microsoft Hindi
            v => v.name.includes('Google हिन्दी'),              // Google Hindi
            v => v.name.includes('Google Hindi'),               // Google Hindi alt
            v => v.lang === 'hi-IN',                            // Any Hindi India
            v => v.lang === 'en-IN',                            // English India
            v => v.name.toLowerCase().includes('india'),        // Name contains India
            v => v.lang.includes('IN'),                         // Any IN locale
            v => v.lang.includes('hi'),                         // Any Hindi
            v => v.lang.startsWith('en') && v.name.includes('Female'), // English female fallback
        ];
        for (const matcher of voicePriority) {
            selectedVoice = voices.find(matcher);
            if (selectedVoice) break;
        }
    }

    onStartCallback?.();

    chunks.forEach((chunk, index) => {
        const utterance = new SpeechSynthesisUtterance(chunk.trim());
        utterance.rate = 1.05;
        if (selectedVoice) utterance.voice = selectedVoice;

        if (index === chunks.length - 1) {
            utterance.onend = () => onEndCallback?.();
            utterance.onerror = () => onEndCallback?.();
        }
        synth.speak(utterance);
    });

    if (synth.paused) synth.resume();
};

export const speakText = async (text, voiceName = null, onEndCallback = null, onStartCallback = null, queueSupport = false) => {
    const cleaned = cleanTextForSpeech(text);
    if (!cleaned || cleaned.trim().length === 0) {
        onEndCallback?.();
        return;
    }

    try {
        const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
        const response = await fetch(`${BACKEND_URL}/api/voice/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleaned, voice: voiceName || 'hi-IN-SwaraNeural' })
        });

        if (response.ok) {
            stopSpeech();
            const blob = await response.blob();
            const audioUrl = URL.createObjectURL(blob);
            const audio = new Audio(audioUrl);
            window.currentAudio = audio;

            audio.onplay = () => onStartCallback?.();
            audio.onended = () => {
                onEndCallback?.();
                URL.revokeObjectURL(audioUrl);
                window.currentAudio = null;
            };
            audio.onerror = () => {
                speakBrowser(cleaned, voiceName, onEndCallback, onStartCallback, queueSupport);
            };
            await audio.play();
            return;
        }
    } catch (e) {
        console.warn("[SpeechUtils] Ultra-fast Indian TTS failed, falling back to browser speech:", e.message);
    }

    return speakBrowser(text, voiceName, onEndCallback, onStartCallback, queueSupport);
};

export const stopSpeech = () => {
    window.speechSynthesis.cancel();
    if (window.currentAudio) {
        window.currentAudio.pause();
        window.currentAudio = null;
    }
};
