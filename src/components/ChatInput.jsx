import React, { useState, useEffect, useRef } from 'react';
import {
    Send, Square, Paperclip, Camera, MicOff, Mic, X
} from 'lucide-react';
import { stopSpeech } from '../utils/speechUtils';

const ChatInput = ({
    input: initialInput,
    onSync,
    handleSubmit: parentHandleSubmit,
    isPlaying, stop,
    isListening, setIsListening,
    selectedImage, setSelectedImage,
    selectedPDF, setSelectedPDF,
    setShowCamera,
    error
}) => {
    const [localInput, setLocalInput] = useState(initialInput || '');
    const fileInputRef = useRef(null);
    const recognitionRef = useRef(null);
    const textareaRef = useRef(null);

    useEffect(() => {
        return () => {
            if (onSync) onSync(localInput);
        };
    }, [localInput, onSync]);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
        }
    }, [localInput]);

    const handleFileSelect = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onloadend = () => {
                const img = new Image();
                img.src = reader.result;
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let width = img.width;
                    let height = img.height;
                    const MAX_SIZE = 1024;

                    if (width > height) {
                        if (width > MAX_SIZE) {
                            height *= MAX_SIZE / width;
                            width = MAX_SIZE;
                        }
                    } else {
                        if (height > MAX_SIZE) {
                            width *= MAX_SIZE / height;
                            height = MAX_SIZE;
                        }
                    }

                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    const resizedBase64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
                    setSelectedImage(resizedBase64);
                    setSelectedPDF(null);
                };
            };
            reader.readAsDataURL(file);
        } else if (file.type === 'application/pdf') {
            try {
                const { extractTextFromPDF } = await import('../utils/pdfUtils');
                const text = await extractTextFromPDF(file);
                if (!text || text.trim() === '') throw new Error("Empty PDF text.");

                setSelectedPDF({ name: file.name, content: text });
                setSelectedImage(null);
            } catch (err) {
                setLocalInput('⚠️ PDF read fail — use a text-based PDF');
                setTimeout(() => setLocalInput(''), 3000);
                setSelectedPDF(null);
            }
        }
    };

    const isStartingRef = useRef(false);

    const handleVoiceInput = () => {
        if (isStartingRef.current || isListening) {
            setIsListening(false);
            isStartingRef.current = false;
            if (recognitionRef.current) {
                recognitionRef.current.onresult = null;
                recognitionRef.current.onend = null;
                recognitionRef.current.stop();
            }
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            setLocalInput('⚠️ Voice not supported — use Chrome or Edge');
            setTimeout(() => setLocalInput(''), 3000);
            return;
        }

        isStartingRef.current = true;
        const recognition = new SpeechRecognition();
        recognitionRef.current = recognition;
        recognition.lang = 'hi-IN';
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.continuous = true;

        setIsListening(true);
        const startInput = localInput;

        recognition.onstart = () => {
            isStartingRef.current = false;
        };

        recognition.onresult = (event) => {
            let transcript = '';
            for (let i = 0; i < event.results.length; ++i) {
                transcript += event.results[i][0].transcript;
            }
            const newText = startInput ? `${startInput.trim()} ${transcript}` : transcript;
            setLocalInput(newText);
        };

        recognition.onerror = (event) => {
            if (event.error === 'not-allowed') {
                setLocalInput('⚠️ Microphone permission denied.');
                setTimeout(() => setLocalInput(''), 3000);
            }
            if (event.error !== 'no-speech') {
                setIsListening(false);
                isStartingRef.current = false;
            }
        };

        recognition.onend = () => {
            setIsListening(false);
            isStartingRef.current = false;
        };

        recognition.start();
    };

    useEffect(() => {
        return () => {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
            }
        };
    }, []);

    const wasSpeakingRef = useRef(false);
    useEffect(() => {
        if (localInput.length === 1 && !wasSpeakingRef.current) {
            stopSpeech();
            wasSpeakingRef.current = true;
        }
        if (localInput.length === 0) {
            wasSpeakingRef.current = false;
        }
    }, [localInput]);

    const internalSubmit = (e) => {
        e?.preventDefault();
        if (localInput.trim() || selectedImage || selectedPDF || isListening) {
            parentHandleSubmit(e, localInput);
            setLocalInput('');
        }
    };

    return (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-white via-white to-transparent pt-6 pb-6 px-4 md:px-0">
            <div className="max-w-3xl mx-auto relative">
                <form onSubmit={internalSubmit} className="relative z-10">
                    {error && (
                        <div className="absolute -top-12 left-0 w-full bg-red-50 border border-red-200 text-red-600 p-2 rounded-lg text-xs flex items-center shadow-sm">
                            <span>CONNECTION ERROR: {error}</span>
                        </div>
                    )}

                    <div className="relative flex flex-col bg-[#f4f4f4] border-transparent focus-within:border-gray-300 focus-within:shadow-sm rounded-[1.5rem] border transition-all pb-3 pt-1 px-2">
                        
                        <div className="flex items-center justify-between pt-1 px-2 pb-1 border-b border-gray-200/10 mb-1">
                            {/* Removed Dark Liya Mode Toggle */}
                            <div />

                            {(selectedImage || selectedPDF) && (
                                <div className="px-2 py-0.5 bg-white/10 border border-white/5 shadow-sm rounded-lg flex items-center gap-1.5">
                                    <span className="text-[10px] text-gray-400 max-w-[120px] truncate font-medium">
                                        {selectedPDF ? `📄 ${selectedPDF.name}` : '🖼️ Attached'}
                                    </span>
                                    <button type="button" onClick={() => { setSelectedImage(null); setSelectedPDF(null); }} className="text-gray-400 hover:text-red-500">
                                        <X size={10} />
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className="flex items-end">
                            <div className="flex items-center gap-1 pl-2 pb-1 text-gray-500">
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileSelect}
                                    className="hidden"
                                    accept="image/*,application/pdf"
                                />
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className={`p-2 rounded-full hover:bg-gray-200 transition-colors ${selectedImage || selectedPDF ? 'text-gray-900' : ''}`}
                                    title="Upload File"
                                >
                                    <Paperclip size={18} />
                                </button>
                            </div>

                            <textarea
                                ref={textareaRef}
                                value={localInput}
                                onChange={(e) => setLocalInput(e.target.value)}
                                onFocus={() => stopSpeech()}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        internalSubmit(e);
                                    }
                                }}
                                placeholder={isListening ? "Listening..." : "Message LIYA..."}
                                className="flex-1 bg-transparent px-2 py-3 text-gray-800 placeholder-gray-500 focus:outline-none text-base resize-none overflow-hidden min-h-[44px] max-h-[200px]"
                                rows={1}
                                autoFocus
                            />

                            <div className="flex items-center gap-1 pr-2 pb-1 text-gray-500">
                                <button
                                    type="button"
                                    onClick={() => setShowCamera(true)}
                                    className="p-2 rounded-full hover:bg-gray-200 transition-colors"
                                    title="Open Camera"
                                >
                                    <Camera size={18} />
                                </button>
                                <button
                                    type="button"
                                    onClick={handleVoiceInput}
                                    className={`p-2 rounded-full hover:bg-gray-200 transition-colors ${isListening ? 'text-red-500' : ''}`}
                                    title="Voice Input"
                                >
                                    {isListening ? <MicOff size={18} /> : <Mic size={18} />}
                                </button>
                                <button
                                    type={isPlaying ? "button" : "submit"}
                                    onClick={isPlaying ? stop : internalSubmit}
                                    disabled={!localInput.trim() && !isPlaying && !selectedImage && !selectedPDF && !isListening}
                                    className={`
                                        p-2 rounded-full flex items-center justify-center transition-all ml-1
                                        ${isPlaying
                                            ? 'bg-gray-800 text-white hover:bg-gray-900'
                                            : localInput.trim() || selectedImage || selectedPDF || isListening
                                                ? 'bg-black text-white hover:bg-gray-800'
                                                : 'bg-gray-300 text-white cursor-not-allowed'
                                        }
                                    `}
                                >
                                    {isPlaying ? <Square size={16} fill="currentColor" /> : <Send size={16} className="ml-0.5" />}
                                </button>
                            </div>
                        </div>
                    </div>
                    <div className="text-center mt-2 text-[11px] text-gray-500">
                        LIYA can make mistakes. Check important info.
                    </div>
                </form>
            </div>
        </div>
    );
};

export default React.memo(ChatInput);
