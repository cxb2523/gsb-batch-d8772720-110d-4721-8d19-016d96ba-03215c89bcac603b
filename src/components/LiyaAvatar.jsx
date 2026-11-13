import React, { useEffect, useRef } from 'react';

const LiyaAvatar = ({ state = 'idle', color = '#00f3ff' }) => {
    const canvasRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        let frameId;
        let time = 0;

        const resize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };

        window.addEventListener('resize', resize);
        resize();

        const draw = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;

            // Determine Animation Parameters based on state
            let speed = 0.01;
            let ringCount = 3;
            let pulseSpeed = 2;
            
            let glowColor = '#94a3b8'; // Slate-400 for idle in light mode

            if (state === 'thinking') {
                speed = 0.05;
                ringCount = 5;
                glowColor = '#818cf8'; // Soft Indigo for thinking in light mode
                pulseSpeed = 8;
            } else if (state === 'speaking') {
                speed = 0.02;
                ringCount = 4;
                glowColor = '#4f46e5'; // Deep Indigo for speaking in light mode
                pulseSpeed = 5;
            }

            ctx.shadowBlur = state === 'idle' ? 20 : 40;
            ctx.shadowColor = glowColor;

            // Draw Background Neural Glow
            const bgGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 300);
            bgGradient.addColorStop(0, `${glowColor}1a`); // 10% opacity
            bgGradient.addColorStop(1, 'transparent');
            ctx.fillStyle = bgGradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Rotating Rings
            for (let i = 0; i < ringCount; i++) {
                ctx.beginPath();
                const baseRadius = 100 + i * 40;
                const radiusPulse = Math.sin(time * pulseSpeed + i) * (state === 'speaking' ? 15 : 5);
                const radius = baseRadius + radiusPulse;

                const startAngle = time * (i % 2 === 0 ? speed : -speed) * (i + 1);
                ctx.arc(centerX, centerY, radius, startAngle, startAngle + Math.PI * 1.5);

                ctx.strokeStyle = `${glowColor}${Math.floor(255 * (0.2 + i * 0.1)).toString(16).padStart(2, '0')}`;
                ctx.lineWidth = 1.5;
                ctx.stroke();

                // Small orbit dots
                const dotX = centerX + Math.cos(startAngle) * radius;
                const dotY = centerY + Math.sin(startAngle) * radius;
                ctx.beginPath();
                ctx.arc(dotX, dotY, 2, 0, Math.PI * 2);
                ctx.fillStyle = glowColor;
                ctx.fill();
            }

            // Inner Core
            ctx.beginPath();
            const coreRadius = 40 + Math.sin(time * 5) * (state === 'speaking' ? 10 : 3);
            ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
            ctx.fillStyle = `${glowColor}10`;
            ctx.fill();
            ctx.strokeStyle = glowColor;
            ctx.lineWidth = 2;
            ctx.stroke();

            // Speaking Waves (Ripples)
            if (state === 'speaking') {
                const rippleTime = (time * 2) % 1;
                ctx.beginPath();
                ctx.arc(centerX, centerY, coreRadius + rippleTime * 200, 0, Math.PI * 2);
                ctx.strokeStyle = `${glowColor}${Math.floor(255 * (1 - rippleTime)).toString(16).padStart(2, '0')}`;
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            time += 0.02;
            frameId = requestAnimationFrame(draw);
        };

        draw();

        return () => {
            window.removeEventListener('resize', resize);
            cancelAnimationFrame(frameId);
        };
    }, [state, color]);

    return (
        <canvas
            ref={canvasRef}
            className="fixed inset-0 pointer-events-none z-0 opacity-40 transition-opacity duration-1000"
            style={{ filter: 'blur(1px)' }}
        />
    );
};

export default React.memo(LiyaAvatar);
