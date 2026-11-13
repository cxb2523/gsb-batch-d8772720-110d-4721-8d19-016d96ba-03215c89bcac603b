import React, { useEffect, useRef } from 'react';
import { config } from '../utils/config';

const TechAnimation = () => {
    const canvasRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        let frameId;
        let time = 0;

        const resize = () => {
            canvas.width = 300;
            canvas.height = 300;
        };
        resize();

        const draw = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;

            // Glow effect
            ctx.shadowBlur = 15;
            ctx.shadowColor = 'rgba(67, 56, 202, 0.2)'; // Indigo shadow in light mode

            // Rotating Rings
            for (let i = 0; i < 3; i++) {
                ctx.beginPath();
                const radius = 60 + i * 30 + Math.sin(time * 2 + i) * 5;
                ctx.arc(centerX, centerY, radius, 0 + time * (i % 2 === 0 ? 1 : -1), Math.PI * 1.5 + time * (i % 2 === 0 ? 1 : -1));
                
                ctx.strokeStyle = i === 1 ? `rgba(67, 56, 202, ${0.1 + i * 0.1})` : `rgba(148, 163, 184, ${0.2 + i * 0.1})`; // Indigo & Slate
                
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // Inner Core Pulse
            ctx.beginPath();
            ctx.arc(centerX, centerY, 30 + Math.sin(time * 5) * 5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(67, 56, 202, 0.05)';
            ctx.fill();
            ctx.strokeStyle = '#4338ca';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Text
            ctx.font = 'bold 20px monospace';
            ctx.fillStyle = '#1e293b'; // Slate 800 in light mode
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowBlur = 0;
            ctx.fillText(config.getAppName(), centerX, centerY);

            time += 0.02;
            frameId = requestAnimationFrame(draw);
        };

        draw();

        return () => cancelAnimationFrame(frameId);
    }, []);

    return (
        <div className="relative flex items-center justify-center">
            <canvas ref={canvasRef} className="w-[300px] h-[300px]" />
        </div>
    );
};

export default React.memo(TechAnimation);
