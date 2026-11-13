import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Camera, RefreshCw } from 'lucide-react';

const CameraCapture = ({ onCapture, onClose }) => {
    const videoRef = useRef(null);
    const [stream, setStream] = useState(null);
    const [error, setError] = useState(null);

    const stopCamera = useCallback(() => {
        setStream(prev => {
            if (prev) {
                prev.getTracks().forEach(track => track.stop());
            }
            return null;
        });
    }, []);

    const startCamera = useCallback(async (isMounted) => {
        try {
            // Priority: User facing, then general camera
            let mediaStream;
            try {
                mediaStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'user' }
                });
            } catch (e) {
                console.warn("User-facing camera failed, trying default:", e);
                mediaStream = await navigator.mediaDevices.getUserMedia({
                    video: true
                });
            }

            if (isMounted) {
                setStream(mediaStream);
                setError(null);
            } else {
                mediaStream.getTracks().forEach(track => track.stop());
            }
        } catch (err) {
            if (isMounted) {
                console.error("Camera access denied:", err);
                setError("Could not access camera. Please allow permissions.");
            }
        }
    }, []);

    // Dedicated effect to attach stream to video element whenever both are available
    useEffect(() => {
        if (stream && videoRef.current && videoRef.current.srcObject !== stream) {
            videoRef.current.srcObject = stream;
            //autoPlay handles the start usually, but we can call play() once and swallow the abort
            videoRef.current.play().catch(e => {
                // Ignore AbortError: The play() request was interrupted by a new load request.
                if (e.name !== 'AbortError') console.warn("Video play error:", e);
            });
        }
    }, [stream]);

    useEffect(() => {
        let isMounted = true;
        startCamera(isMounted);
        return () => {
            isMounted = false;
            stopCamera();
        };
    }, [startCamera, stopCamera]);

    const takePhoto = () => {
        if (!videoRef.current || videoRef.current.readyState < 2) {
            console.warn("Camera not ready for capture");
            return;
        }

        const video = videoRef.current;
        let width = video.videoWidth;
        let height = video.videoHeight;

        if (width <= 0 || height <= 0) {
            console.warn("Invalid video dimensions:", width, height);
            return;
        }

        const canvas = document.createElement('canvas');
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
        const ctx = canvas.getContext('2d', { alpha: false }); // Use alpha: false for performance and to avoid transparency issues

        // Fill with black first ensures we don't have transparency, 
        // but drawImage should cover it anyway.
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, width, height);

        // Flip horizontally if using user-facing camera (mirror effect)
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);

        ctx.drawImage(video, 0, 0, width, height);

        // Reset transform
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        try {
            const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
            if (!base64 || base64.length < 100) {
                throw new Error("Captured image is too small or empty");
            }
            onCapture(base64);
            stopCamera();
            onClose();
        } catch (e) {
            console.error("Capture capture failed:", e);
            setError("Failed to process image capture.");
        }
    };

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-white backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative bg-white border border-gray-300 rounded-2xl overflow-hidden shadow-2xl max-w-2xl w-full mx-4">

                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-gray-50">
                    <div className="flex items-center gap-2 text-gray-900">
                        <Camera size={20} />
                        <span className="font-mono text-sm tracking-wider">CAMERA</span>
                    </div>
                    <button onClick={() => { stopCamera(); onClose(); }} className="text-gray-500 hover:text-gray-900 transition-colors">
                        <X size={20} />
                    </button>
                </div>

                {/* Viewfinder */}
                <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden">
                    {!stream && !error ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-0">
                            <div className="flex flex-col items-center gap-3">
                                <RefreshCw className="w-8 h-8 text-accent-blue animate-spin opacity-50" />
                                <span className="text-accent-blue/50 font-mono text-[10px] tracking-widest uppercase">Initializing...</span>
                            </div>
                        </div>
                    ) : null}

                    {error ? (
                        <div className="text-red-500 font-mono text-center p-4 z-10">
                            <X size={40} className="mx-auto mb-2 opacity-50" />
                            {error}
                        </div>
                    ) : (
                        <video
                            ref={videoRef}
                            autoPlay
                            playsInline
                            muted
                            className="w-full h-full object-cover transform scale-x-[-1]"
                        />
                    )}

                    {/* HUD Overlay */}
                    <div className="absolute inset-0 pointer-events-none border border-gray-300 rounded-lg m-4">
                        {/* Crosshairs */}
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 opacity-50">
                            <div className="absolute top-0 left-1/2 -translate-x-1/2 h-full w-[1px] bg-accent-blue"></div>
                            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-[1px] bg-accent-blue"></div>
                        </div>
                        {/* Corner Brackets */}
                        <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-accent-blue"></div>
                        <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-accent-blue"></div>
                        <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-accent-blue"></div>
                        <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-accent-blue"></div>
                    </div>
                </div>

                {/* Controls */}
                <div className="p-6 flex items-center justify-center bg-gray-50 border-t border-gray-200">
                    <button
                        onClick={takePhoto}
                        disabled={!!error}
                        className="group relative flex items-center justify-center w-16 h-16 rounded-full border-4 border-gray-400 hover:border-accent-blue transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <div className="w-12 h-12 bg-white rounded-full group-hover:scale-90 transition-transform"></div>
                    </button>
                </div>
            </div>
        </div>
    );
};

export default CameraCapture;
