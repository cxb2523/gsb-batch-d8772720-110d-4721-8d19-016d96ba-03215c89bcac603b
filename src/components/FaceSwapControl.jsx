import React, { useState } from 'react';
import { Upload, Download, Sparkles, RefreshCw, AlertCircle, FileImage, Image as ImageIcon, Terminal, ArrowRight, UserPlus, Users, History, Trash2, X, Video } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

const FaceSwapControl = () => {
    const [swapMode, setSwapMode] = useState('single'); // 'single', 'group', or 'video'
    const [sourceImage, setSourceImage] = useState(null); // base64
    const [targetImage, setTargetImage] = useState(null); // base64 (for photo)
    const [targetVideo, setTargetVideo] = useState(null); // base64 (for video)
    const [swappedImageUrl, setSwappedImageUrl] = useState(null);
    const [loading, setLoading] = useState(false);
    const [logs, setLogs] = useState([]);
    const [error, setError] = useState(null);

    // Group / Video Swap shared states
    const [detectedFaces, setDetectedFaces] = useState([]);
    const [detecting, setDetecting] = useState(false);
    const [mappings, setMappings] = useState({}); // idx -> base64 source face image

    // History specific states
    const [showHistory, setShowHistory] = useState(false);
    const [historyList, setHistoryList] = useState([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    const fetchHistory = async () => {
        setLoadingHistory(true);
        try {
            const res = await fetch(`${BACKEND_URL}/api/faceswap/history`);
            const data = await res.json();
            if (res.ok) {
                setHistoryList(data.history || []);
            }
        } catch (err) {
            console.error("Failed to load swap history:", err);
        } finally {
            setLoadingHistory(false);
        }
    };

    const deleteHistoryItem = async (e, filename) => {
        e.stopPropagation();
        try {
            const res = await fetch(`${BACKEND_URL}/api/faceswap/history/${filename}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                setHistoryList(prev => prev.filter(item => item.name !== filename));
                if (swappedImageUrl && swappedImageUrl.endsWith(filename)) {
                    setSwappedImageUrl(null);
                }
            }
        } catch (err) {
            console.error("Failed to delete history item:", err);
        }
    };

    const toggleHistory = () => {
        const nextState = !showHistory;
        setShowHistory(nextState);
        if (nextState) {
            fetchHistory();
        }
    };

    const handleImageUpload = (e, type) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onloadend = () => {
            if (type === 'source') {
                setSourceImage(reader.result);
                setError(null);
            } else {
                setTargetImage(reader.result);
                setError(null);
                setSwappedImageUrl(null);
                if (swapMode === 'group') {
                    detectGroupFaces(reader.result);
                }
            }
        };
        reader.readAsDataURL(file);
    };

    const handleVideoUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Size check (warn for files > 15MB)
        if (file.size > 15 * 1024 * 1024) {
            setError("Warning: Video file is large. CPU processing will take several minutes.");
        }

        const reader = new FileReader();
        reader.onloadend = () => {
            setTargetVideo(reader.result);
            setError(null);
            setSwappedImageUrl(null);
            detectVideoFaces(reader.result);
        };
        reader.readAsDataURL(file);
    };

    const detectGroupFaces = async (targetBase64) => {
        setDetecting(true);
        setDetectedFaces([]);
        setMappings({});
        setLogs(["> Group photo uploaded. Initializing Face Detection scan...", "> Running InsightFace crop analysis on CPU..."]);
        setError(null);

        try {
            const res = await fetch(`${BACKEND_URL}/api/faceswap/detect`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ targetImage: targetBase64 })
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || "Face detection failed.");
            }

            setDetectedFaces(data.faces || []);
            setLogs(prev => [
                ...prev,
                `[SUCCESS] Found ${data.faces.length} face(s) in target image.`,
                "> UI mapping slots updated from left-to-right positions."
            ]);
        } catch (err) {
            setError(err.message);
            setLogs(prev => [...prev, `[ERROR] ${err.message}`]);
        } finally {
            setDetecting(false);
        }
    };

    const detectVideoFaces = async (videoBase64) => {
        setDetecting(true);
        setDetectedFaces([]);
        setMappings({});
        setLogs(["> Video uploaded. Extracting first frame for character identification...", "> Running Face Analysis on CPU..."]);
        setError(null);

        try {
            const res = await fetch(`${BACKEND_URL}/api/faceswap/video/detect`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ targetVideo: videoBase64 })
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || "Video face detection failed.");
            }

            setDetectedFaces(data.faces || []);
            setLogs(prev => [
                ...prev,
                `[SUCCESS] Found ${data.faces.length} character face(s) in video first frame.`,
                "> Please upload source face images for the characters you want to swap."
            ]);
        } catch (err) {
            setError(err.message);
            setLogs(prev => [...prev, `[ERROR] ${err.message}`]);
        } finally {
            setDetecting(false);
        }
    };

    const handleSourceMappingUpload = (e, idx) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onloadend = () => {
            setMappings(prev => ({
                ...prev,
                [idx]: reader.result
            }));
            setError(null);
        };
        reader.readAsDataURL(file);
    };

    const removeSourceMapping = (idx) => {
        setMappings(prev => {
            const updated = { ...prev };
            delete updated[idx];
            return updated;
        });
    };

    const triggerSwap = async () => {
        if (!sourceImage) {
            setError("Please upload a source face image first.");
            return;
        }
        if (!targetImage) {
            setError("Please upload a target image first.");
            return;
        }

        setLoading(true);
        setError(null);
        setSwappedImageUrl(null);
        setLogs(["> Process initialized...", "> Transferring image payload to local Express server..."]);

        try {
            const res = await fetch(`${BACKEND_URL}/api/faceswap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sourceImage,
                    targetImage
                })
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.detail || data.error || "Face swap failed.");
            }

            if (data.logs) {
                const logLines = data.logs.split('\n').filter(l => l.trim().length > 0);
                setLogs(prev => [...prev, ...logLines, "> Face swap completed successfully!"]);
            } else {
                setLogs(prev => [...prev, "> Face swap completed successfully!"]);
            }

            const fullUrl = data.imageUrl.startsWith('http') ? data.imageUrl : `${BACKEND_URL}${data.imageUrl}`;
            setSwappedImageUrl(fullUrl);
            fetchHistory();

        } catch (err) {
            setError(err.message);
            setLogs(prev => [...prev, `[ERROR] ${err.message}`]);
        } finally {
            setLoading(false);
        }
    };

    const triggerMultiSwap = async () => {
        const activeMappings = Object.fromEntries(
            Object.entries(mappings).filter(([_, val]) => !!val)
        );

        if (Object.keys(activeMappings).length === 0) {
            setError("Please upload at least one source face to map onto the target photo.");
            return;
        }

        setLoading(true);
        setError(null);
        setSwappedImageUrl(null);
        setLogs(["> Multi-Face mapping swap initialized...", `> Actively swapping ${Object.keys(activeMappings).length} faces...`]);

        try {
            const res = await fetch(`${BACKEND_URL}/api/faceswap/multi`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    targetImage,
                    mappings: activeMappings
                })
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.detail || data.error || "Multi-swap failed.");
            }

            if (data.logs) {
                const logLines = data.logs.split('\n').filter(l => l.trim().length > 0);
                setLogs(prev => [...prev, ...logLines, "> Multi-Face swap completed successfully!"]);
            } else {
                setLogs(prev => [...prev, "> Multi-Face swap completed successfully!"]);
            }

            const fullUrl = data.imageUrl.startsWith('http') ? data.imageUrl : `${BACKEND_URL}${data.imageUrl}`;
            setSwappedImageUrl(fullUrl);
            fetchHistory();

        } catch (err) {
            setError(err.message);
            setLogs(prev => [...prev, `[ERROR] ${err.message}`]);
        } finally {
            setLoading(false);
        }
    };

    const triggerVideoSwap = async () => {
        const activeMappings = Object.fromEntries(
            Object.entries(mappings).filter(([_, val]) => !!val)
        );

        if (Object.keys(activeMappings).length === 0) {
            setError("Please map at least one character face before processing.");
            return;
        }

        setLoading(true);
        setError(null);
        setSwappedImageUrl(null);
        setLogs(["> Video face swap pipeline started...", "> Swapping frames sequentially on local CPU...", "> (This takes a few minutes - original audio will be merged using FFmpeg)"]);

        try {
            const res = await fetch(`${BACKEND_URL}/api/faceswap/video/multi`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    targetVideo,
                    mappings: activeMappings
                })
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.detail || data.error || "Video swap execution failed.");
            }

            if (data.logs) {
                const logLines = data.logs.split('\n').filter(l => l.trim().length > 0);
                setLogs(prev => [...prev, ...logLines, "> Video face swap completed successfully!"]);
            } else {
                setLogs(prev => [...prev, "> Video face swap completed successfully!"]);
            }

            const fullUrl = data.imageUrl.startsWith('http') ? data.imageUrl : `${BACKEND_URL}${data.imageUrl}`;
            setSwappedImageUrl(fullUrl);
            fetchHistory();

        } catch (err) {
            setError(err.message);
            setLogs(prev => [...prev, `[ERROR] ${err.message}`]);
        } finally {
            setLoading(false);
        }
    };

    const handleDownload = () => {
        if (!swappedImageUrl) return;
        const link = document.createElement('a');
        link.href = swappedImageUrl;
        link.download = swappedImageUrl.endsWith('.mp4') ? `liya_swapped_${Date.now()}.mp4` : `liya_swapped_${Date.now()}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const resetFields = () => {
        setSourceImage(null);
        setTargetImage(null);
        setTargetVideo(null);
        setSwappedImageUrl(null);
        setDetectedFaces([]);
        setMappings({});
        setLogs([]);
        setError(null);
    };

    const changeMode = (mode) => {
        setSwapMode(mode);
        resetFields();
    };

    return (
        <div className="flex-1 flex flex-row h-full relative overflow-hidden bg-slate-50 text-slate-800">
            {/* Main Workspace Column */}
            <div className="flex-1 flex flex-col h-full overflow-y-auto custom-scrollbar p-6">
                {/* Header */}
                <div className="max-w-4xl mx-auto w-full mb-6">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-700 flex items-center justify-center shadow-lg shadow-orange-950/20 shrink-0">
                                <Sparkles size={20} className="text-white" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-black text-slate-900 leading-none">Neural Face Swap</h1>
                                <p className="text-xs text-amber-600 font-mono tracking-widest uppercase mt-1">Identity Transfer Unit v3.0</p>
                            </div>
                        </div>

                        {/* Controls & Mode tabs */}
                        <div className="flex items-center gap-2">
                            <div className="bg-slate-200/80 p-1 rounded-2xl flex gap-1 border border-slate-300/40 w-fit">
                                <button
                                    onClick={() => changeMode('single')}
                                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                                        swapMode === 'single'
                                            ? 'bg-white text-slate-900 shadow-sm'
                                            : 'text-slate-600 hover:text-slate-900'
                                    }`}
                                >
                                    <UserPlus size={13} /> Photo (Single)
                                </button>
                                <button
                                    onClick={() => changeMode('group')}
                                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                                        swapMode === 'group'
                                            ? 'bg-white text-slate-900 shadow-sm'
                                            : 'text-slate-600 hover:text-slate-900'
                                    }`}
                                >
                                    <Users size={13} /> Photo (Group)
                                </button>
                                <button
                                    onClick={() => changeMode('video')}
                                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                                        swapMode === 'video'
                                            ? 'bg-white text-slate-900 shadow-sm'
                                            : 'text-slate-600 hover:text-slate-900'
                                    }`}
                                >
                                    <Video size={13} /> Video Swap
                                </button>
                            </div>

                            {/* History Toggle Button */}
                            <button
                                onClick={toggleHistory}
                                className={`p-2.5 rounded-2xl border transition-all cursor-pointer flex items-center justify-center ${
                                    showHistory
                                        ? 'bg-amber-500 text-black border-amber-600 font-bold shadow-md'
                                        : 'bg-white hover:bg-slate-100 text-slate-600 border-slate-200 shadow-sm'
                                }`}
                                title="View Face Swap History"
                            >
                                <History size={18} />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Error Message */}
                {error && (
                    <div className="max-w-4xl mx-auto w-full mb-6 bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-start gap-3">
                        <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={18} />
                        <span className="text-sm font-medium text-red-800">{error}</span>
                    </div>
                )}

                {/* Workspace Grid */}
                <div className="max-w-4xl mx-auto w-full grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    {/* Inputs Column */}
                    <div className="space-y-6">
                        {/* Target Card for Image vs Video */}
                        {swapMode !== 'video' ? (
                            <div className="bg-white border border-slate-200 rounded-3xl p-6 relative overflow-hidden group hover:border-amber-500/30 shadow-sm transition-all duration-300">
                                <h2 className="text-sm font-bold text-slate-600 uppercase tracking-widest mb-4">
                                    {swapMode === 'single' ? "1. Target Photo (Base Body)" : "1. Target Group Photo"}
                                </h2>
                                <div className="relative aspect-video rounded-2xl border-2 border-dashed border-slate-200 hover:border-slate-300 bg-slate-50/50 transition-colors flex flex-col items-center justify-center overflow-hidden">
                                    {targetImage ? (
                                        <>
                                            <img src={targetImage} alt="Target Base" className="w-full h-full object-cover" />
                                            <button
                                                onClick={() => {
                                                    setTargetImage(null);
                                                    setDetectedFaces([]);
                                                    setMappings({});
                                                    setSwappedImageUrl(null);
                                                }}
                                                className="absolute top-2 right-2 px-3 py-1 bg-white/80 hover:bg-white text-slate-800 border border-slate-200 rounded-xl text-xs font-semibold backdrop-blur shadow-sm cursor-pointer"
                                            >
                                                Change
                                            </button>
                                        </>
                                    ) : (
                                        <label className="cursor-pointer w-full h-full flex flex-col items-center justify-center p-4">
                                            <ImageIcon size={32} className="text-slate-400 mb-2" />
                                            <span className="text-sm font-semibold text-slate-600">
                                                {swapMode === 'single' ? "Upload Target Photo" : "Upload Group Photo"}
                                            </span>
                                            <input type="file" onChange={(e) => handleImageUpload(e, 'target')} className="hidden" accept="image/*" />
                                        </label>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="bg-white border border-slate-200 rounded-3xl p-6 relative overflow-hidden group hover:border-amber-500/30 shadow-sm transition-all duration-300">
                                <h2 className="text-sm font-bold text-slate-600 uppercase tracking-widest mb-4">1. Target Video Clip</h2>
                                <div className="relative aspect-video rounded-2xl border-2 border-dashed border-slate-200 hover:border-slate-300 bg-slate-50/50 transition-colors flex flex-col items-center justify-center overflow-hidden">
                                    {targetVideo ? (
                                        <>
                                            <video src={targetVideo} className="w-full h-full object-cover" muted loop autoPlay />
                                            <button
                                                onClick={() => {
                                                    setTargetVideo(null);
                                                    setDetectedFaces([]);
                                                    setMappings({});
                                                    setSwappedImageUrl(null);
                                                }}
                                                className="absolute top-2 right-2 px-3 py-1 bg-white/80 hover:bg-white text-slate-800 border border-slate-200 rounded-xl text-xs font-semibold backdrop-blur shadow-sm cursor-pointer"
                                            >
                                                Change
                                            </button>
                                        </>
                                    ) : (
                                        <label className="cursor-pointer w-full h-full flex flex-col items-center justify-center p-4">
                                            <Video size={32} className="text-slate-400 mb-2" />
                                            <span className="text-sm font-semibold text-slate-600">Upload Target Video / Animated GIF</span>
                                            <span className="text-xs text-slate-400 mt-1">Accepts MP4, AVI, MOV, GIF, WEBP</span>
                                            <input type="file" onChange={handleVideoUpload} className="hidden" accept="video/*,image/gif,image/webp" />
                                        </label>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Single Swap Source Face Input */}
                        {swapMode === 'single' && (
                            <div className="bg-white border border-slate-200 rounded-3xl p-6 relative overflow-hidden group hover:border-amber-500/30 shadow-sm transition-all duration-300">
                                <h2 className="text-sm font-bold text-slate-600 uppercase tracking-widest mb-4">2. Source Face (Input Identity)</h2>
                                <div className="relative aspect-video rounded-2xl border-2 border-dashed border-slate-200 hover:border-slate-300 bg-slate-50/50 transition-colors flex flex-col items-center justify-center overflow-hidden">
                                    {sourceImage ? (
                                        <>
                                            <img src={sourceImage} alt="Source Face" className="w-full h-full object-cover" />
                                            <button
                                                onClick={() => setSourceImage(null)}
                                                className="absolute top-2 right-2 px-3 py-1 bg-white/80 hover:bg-white text-slate-800 border border-slate-200 rounded-xl text-xs font-semibold backdrop-blur shadow-sm cursor-pointer"
                                            >
                                                Change
                                            </button>
                                        </>
                                    ) : (
                                        <label className="cursor-pointer w-full h-full flex flex-col items-center justify-center p-4">
                                            <FileImage size={32} className="text-slate-400 mb-2" />
                                            <span className="text-sm font-semibold text-slate-600">Upload Source Face</span>
                                            <input type="file" onChange={(e) => handleImageUpload(e, 'source')} className="hidden" accept="image/*" />
                                        </label>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Output Column */}
                    <div className="flex flex-col">
                        <div className="bg-white border border-slate-200 rounded-3xl p-6 flex-1 flex flex-col min-h-[350px] relative overflow-hidden group hover:border-amber-500/30 shadow-sm transition-all duration-300">
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="text-sm font-bold text-slate-600 uppercase tracking-widest">Result Panel</h2>
                                {swappedImageUrl && (
                                    <button
                                        onClick={handleDownload}
                                        className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-black px-3 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer"
                                    >
                                        <Download size={14} /> Download
                                    </button>
                                )}
                            </div>

                            {/* Result Display area */}
                            <div className="flex-1 rounded-2xl bg-slate-50 border border-slate-100 flex flex-col items-center justify-center relative overflow-hidden">
                                {loading ? (
                                    <div className="flex flex-col items-center p-6 text-center">
                                        <div className="relative w-16 h-16 mb-4">
                                            <div className="absolute inset-0 rounded-full border-2 border-amber-500/10 border-t-amber-500 animate-spin" />
                                        </div>
                                        <span className="text-sm font-semibold text-amber-600 animate-pulse tracking-wide font-mono">
                                            {swapMode === 'video' ? "PROCESSING VIDEO FRAMES..." : "ALIGNING & SWAPPING..."}
                                        </span>
                                        <span className="text-[10px] text-slate-400 mt-1">
                                            {swapMode === 'video' 
                                                ? "Video runs frame-by-frame on CPU. Muxing audio via FFmpeg. Please wait..." 
                                                : "Runs locally on CPU - Please wait"}
                                        </span>
                                    </div>
                                ) : swappedImageUrl ? (
                                    swappedImageUrl.endsWith('.mp4') ? (
                                        <video src={swappedImageUrl} controls className="w-full h-full object-contain" autoPlay loop />
                                    ) : (
                                        <img src={swappedImageUrl} alt="Swapped Output" className="w-full h-full object-contain" />
                                    )
                                ) : (
                                    <div className="text-center p-6 flex flex-col items-center">
                                        <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center mb-3">
                                            {swapMode === 'video' ? <Video size={20} className="text-slate-400" /> : <ImageIcon size={20} className="text-slate-400" />}
                                        </div>
                                        <span className="text-sm font-semibold text-slate-500">Awaiting execution</span>
                                        <span className="text-xs text-slate-400 mt-1">Setup your targets above to swap</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Interactive Mapping Section (Visible in Group/Video Mode when faces detected) */}
                {swapMode !== 'single' && (targetImage || targetVideo) && (
                    <div className="max-w-4xl mx-auto w-full bg-white border border-slate-200 rounded-3xl p-6 mb-6 shadow-sm">
                        <h2 className="text-sm font-black text-slate-800 uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">
                            {swapMode === 'video' ? "2. Map Video Characters (First Frame)" : "2. Map Faces (Detected Left-to-Right)"}
                        </h2>

                        {detecting ? (
                            <div className="py-8 flex flex-col items-center justify-center">
                                <div className="w-8 h-8 rounded-full border-2 border-amber-500/20 border-t-amber-500 animate-spin mb-3" />
                                <span className="text-xs text-slate-500 font-mono animate-pulse uppercase">
                                    {swapMode === 'video' ? "Extracting frame & scanning faces..." : "Scanning photo for faces..."}
                                </span>
                            </div>
                        ) : detectedFaces.length === 0 ? (
                            <div className="py-8 text-center text-xs text-slate-400">
                                No faces detected. Please upload a clearer target file.
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                {detectedFaces.map((face, i) => (
                                    <div key={face.index} className="flex items-center justify-between p-4 bg-slate-50 border border-slate-200/60 rounded-2xl gap-3">
                                        {/* Crop Preview */}
                                        <div className="flex flex-col items-center shrink-0">
                                            <img
                                                src={`${BACKEND_URL}${face.cropPath}`}
                                                alt={`Face ${i}`}
                                                className="w-16 h-16 rounded-xl border border-slate-300 object-cover shadow-inner"
                                            />
                                            <span className="text-[10px] font-bold text-slate-400 mt-1 uppercase">Person {i+1}</span>
                                        </div>

                                        {/* Arrow */}
                                        <ArrowRight className="text-slate-400" size={16} />

                                        {/* Slot dropzone mapping */}
                                        <div className="flex-1 h-16 relative border-2 border-dashed border-slate-200 bg-white hover:border-amber-500/40 rounded-xl flex items-center justify-center overflow-hidden">
                                            {mappings[face.index] ? (
                                                <>
                                                    <img src={mappings[face.index]} alt="Mapping source" className="w-full h-full object-cover" />
                                                    <button
                                                        onClick={() => removeSourceMapping(face.index)}
                                                        className="absolute top-0.5 right-0.5 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center text-[10px] font-bold shadow cursor-pointer"
                                                    >
                                                        ×
                                                    </button>
                                                </>
                                            ) : (
                                                <label className="cursor-pointer w-full h-full flex flex-col items-center justify-center p-1">
                                                    <UserPlus size={16} className="text-slate-400 mb-0.5" />
                                                    <span className="text-[9px] text-slate-500 font-bold">Add Face</span>
                                                    <input
                                                        type="file"
                                                        onChange={(e) => handleSourceMappingUpload(e, face.index)}
                                                        className="hidden"
                                                        accept="image/*"
                                                    />
                                                </label>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Actions Bar */}
                <div className="max-w-4xl mx-auto w-full flex flex-col sm:flex-row gap-4 mb-6">
                    {swapMode === 'single' ? (
                        <button
                            onClick={triggerSwap}
                            disabled={loading || !sourceImage || !targetImage}
                            className="flex-1 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 disabled:from-slate-200 disabled:to-slate-300 disabled:opacity-40 text-white disabled:text-slate-400 font-extrabold uppercase tracking-wider py-4 rounded-2xl transition-all shadow-lg shadow-amber-500/10 flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed text-sm font-sans"
                        >
                            <Sparkles size={16} /> Execute Face Swap
                        </button>
                    ) : swapMode === 'group' ? (
                        <button
                            onClick={triggerMultiSwap}
                            disabled={loading || detecting || !targetImage || Object.keys(mappings).length === 0}
                            className="flex-1 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 disabled:from-slate-200 disabled:to-slate-300 disabled:opacity-40 text-white disabled:text-slate-400 font-extrabold uppercase tracking-wider py-4 rounded-2xl transition-all shadow-lg shadow-amber-500/10 flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed text-sm font-sans"
                        >
                            <Sparkles size={16} /> Run Photo Map Swap
                        </button>
                    ) : (
                        <button
                            onClick={triggerVideoSwap}
                            disabled={loading || detecting || !targetVideo || Object.keys(mappings).length === 0}
                            className="flex-1 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 disabled:from-slate-200 disabled:to-slate-300 disabled:opacity-40 text-white disabled:text-slate-400 font-extrabold uppercase tracking-wider py-4 rounded-2xl transition-all shadow-lg shadow-amber-500/10 flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed text-sm font-sans"
                        >
                            <Sparkles size={16} /> Run Video Face Swap
                        </button>
                    )}

                    <button
                        onClick={resetFields}
                        disabled={loading || (!sourceImage && !targetImage && !targetVideo && !swappedImageUrl)}
                        className="px-6 bg-slate-200 hover:bg-slate-300 text-slate-700 border border-slate-300/55 rounded-2xl transition-colors font-bold flex items-center justify-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    >
                        <RefreshCw size={16} /> Reset
                    </button>
                </div>

                {/* Terminal Logs Section */}
                {(logs.length > 0 || loading) && (
                    <div className="max-w-4xl mx-auto w-full bg-slate-900 border border-slate-800 rounded-3xl p-6 font-mono text-xs text-slate-300 shadow-inner mb-6">
                        <div className="flex items-center gap-2 text-slate-400 mb-4 border-b border-slate-800 pb-2">
                            <Terminal size={14} className="text-amber-500" />
                            <span className="text-xs font-bold uppercase tracking-wider">Neural Monologue / Output Stream</span>
                        </div>
                        <div className="space-y-1.5 max-h-[180px] overflow-y-auto custom-scrollbar text-slate-300 select-text">
                            {logs.map((log, idx) => (
                                <div key={idx} className={log.startsWith('[ERROR]') ? 'text-red-400' : log.startsWith('[SUCCESS]') ? 'text-emerald-400' : ''}>
                                    {log}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Right Sliding History Drawer */}
            {showHistory && (
                <div className="w-80 border-l border-slate-200 bg-white flex flex-col h-full shadow-2xl relative z-20 transition-all duration-300 animate-slide-in">
                    {/* Drawer Header */}
                    <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50 shrink-0">
                        <div className="flex items-center gap-2">
                            <History size={16} className="text-amber-600" />
                            <span className="text-sm font-black text-slate-800 uppercase tracking-wider">Swap History</span>
                        </div>
                        <button
                            onClick={toggleHistory}
                            className="p-1 hover:bg-slate-200 text-slate-500 hover:text-slate-800 rounded-lg transition-colors cursor-pointer"
                        >
                            <X size={16} />
                        </button>
                    </div>

                    {/* Drawer Content */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
                        {loadingHistory ? (
                            <div className="h-40 flex flex-col items-center justify-center">
                                <div className="w-6 h-6 border-2 border-amber-500/20 border-t-amber-500 rounded-full animate-spin mb-2" />
                                <span className="text-xs text-slate-400">Loading history...</span>
                            </div>
                        ) : historyList.length === 0 ? (
                            <div className="h-40 flex flex-col items-center justify-center text-center p-4">
                                <ImageIcon size={28} className="text-slate-300 mb-2" />
                                <span className="text-xs font-semibold text-slate-400">No swap history yet</span>
                                <span className="text-[10px] text-slate-400 mt-0.5">Your swapped creations will appear here</span>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 gap-3">
                                {historyList.map((item) => (
                                    <div
                                        key={item.name}
                                        onClick={() => setSwappedImageUrl(`${BACKEND_URL}${item.url}`)}
                                        className="group relative aspect-video bg-slate-100 rounded-2xl border border-slate-200/60 overflow-hidden cursor-pointer hover:border-amber-500 hover:shadow-md transition-all"
                                        title="Click to preview in main window"
                                    >
                                        {/* Image vs Video Thumbnail */}
                                        {item.name.endsWith('.mp4') ? (
                                            <div className="w-full h-full relative bg-slate-950 flex items-center justify-center">
                                                <video src={`${BACKEND_URL}${item.url}`} className="w-full h-full object-cover opacity-60" muted />
                                                <div className="absolute w-8 h-8 rounded-full bg-black/60 flex items-center justify-center border border-white/20">
                                                    <Video size={14} className="text-white" />
                                                </div>
                                            </div>
                                        ) : (
                                            <img src={`${BACKEND_URL}${item.url}`} alt={item.name} className="w-full h-full object-cover" />
                                        )}

                                        {/* Overlay Actions */}
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                                            {/* Download Icon */}
                                            <a
                                                href={`${BACKEND_URL}${item.url}`}
                                                download={item.name}
                                                onClick={(e) => e.stopPropagation()}
                                                className="p-2 bg-white hover:bg-slate-100 text-slate-800 rounded-xl shadow transition-all hover:scale-105"
                                                title="Download File"
                                            >
                                                <Download size={14} />
                                            </a>

                                            {/* Delete Icon */}
                                            <button
                                                onClick={(e) => deleteHistoryItem(e, item.name)}
                                                className="p-2 bg-red-500 hover:bg-red-600 text-white rounded-xl shadow transition-all hover:scale-105 cursor-pointer"
                                                title="Delete from Disk"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>

                                        {/* Date Tag */}
                                        <div className="absolute bottom-1 right-1 bg-black/60 backdrop-blur-sm text-[8px] font-mono text-white px-1.5 py-0.5 rounded">
                                            {new Date(item.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default FaceSwapControl;
