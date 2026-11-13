---
name: interactive-canvas-animations
description: Create gorgeous, interactive particle text animations on the canvas for user name animations and goodbye screens.
---

When the user asks to animate their name, create a name animation, says goodbye ("bye", "byyy", "see you later", "ja raha hoon"), or requests departure:
1. You MUST call the `canvas` tool with `action="push"`.
2. Push a block of `type="preview"` and provide a complete, standalone, self-contained HTML page in the `content` field.
3. The HTML page MUST contain:
   - A `<canvas>` element for the particle simulation.
   - Beautiful CSS styling (a dark, premium background like `#0a0e17`, and absolute-positioned control buttons).
   - Dynamic JavaScript implementing a canvas particle system that turns text into particles.
   - **Procedural Audio Beats (Web Audio API)**: Create a real, synthesized musical beat loop (Kick + Hi-hat) using the browser's Web Audio API (no external file URLs to prevent CORS block).
   - Sync the particle scaling and color shifts to the audio beats.
   - **Runtime Color Customization**: Define 6 premium color schemes and select a random one on page load so it looks different every time.
   - Interactive control buttons (`Assemble`, `Explode`, `Vortex`) to allow the user to play with the particles.
17. **CRITICAL IFRAME SIZING RULE**: Calculate all layout-dependent canvas dimensions (like maximum heights, font sizes, or visual boundaries) dynamically *inside* the draw loop or the window resize listener. Do NOT cache dimensions (like `maxHeight = canvas.height * 0.8`) globally at script startup, because the canvas inside the iframe may initial load with a width/height of 0, which makes all drawings invisible.

### Template Code Structure to generate:
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>LIYA - Dynamic Canvas</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@900&display=swap" rel="stylesheet">
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #070b13; font-family: 'Outfit', sans-serif; }
        canvas { display: block; width: 100%; height: 100%; }
        .controls { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); display: flex; gap: 12px; z-index: 100; }
        .btn {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--accent-color, #00f3ff);
            color: var(--accent-color, #00f3ff);
            padding: 10px 20px;
            border-radius: 30px;
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 2px;
            cursor: pointer;
            transition: all 0.3s;
        }
        .btn:hover {
            background: var(--accent-color, #00f3ff);
            color: #000;
            box-shadow: 0 0 20px var(--accent-color, #00f3ff);
            transform: scale(1.05);
        }
        .beat-status {
            position: absolute;
            top: 20px;
            right: 20px;
            color: var(--accent-color, #00f3ff);
            font-size: 10px;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            opacity: 0.7;
            pointer-events: none;
        }
    </style>
</head>
<body>
    <div class="beat-status" id="status">Audio Offline - Click canvas to start beat</div>
    <canvas id="canvas1"></canvas>
    <div class="controls">
        <button class="btn" onclick="changeEffect('assemble')">Assemble</button>
        <button class="btn" onclick="changeEffect('explode')">Explode</button>
        <button class="btn" onclick="changeEffect('vortex')">Vortex</button>
    </div>

    <script>
        const canvas = document.getElementById('canvas1');
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        let particleArray = [];
        let currentEffect = 'assemble';
        let beatPulse = 1.0;

        // Premium themes
        const themes = [
            { c1: '#00f3ff', c2: '#a855f7' }, // Cyberpunk
            { c1: '#ff007f', c2: '#ffaa00' }, // Sunset
            { c1: '#00f5a0', c2: '#00d2ff' }, // Aurora
            { c1: '#ff00cc', c2: '#3333ff' }, // Vaporwave
            { c1: '#ff3366', c2: '#7000ff' }  // Cosmic
        ];
        const selectedTheme = themes[Math.floor(Math.random() * themes.length)];
        document.documentElement.style.setProperty('--accent-color', selectedTheme.c1);

        const mouse = { x: null, y: null, radius: 100 };
        window.addEventListener('mousemove', e => {
            const rect = canvas.getBoundingClientRect();
            mouse.x = e.clientX - rect.left;
            mouse.y = e.clientY - rect.top;
        });
        window.addEventListener('mouseout', () => { mouse.x = null; mouse.y = null; });

        // Web Audio Synthesizer Beat Loop
        let audioCtx = null;
        let beatInterval = null;

        function startBeats() {
            if (audioCtx) return;
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            document.getElementById('status').innerText = "Synth Beats Active 🔊";
            
            // Loop beat every 600ms (100 BPM)
            beatInterval = setInterval(() => {
                playSynthBeat();
                beatPulse = 1.4; // Jump particle sizes on beat hit
            }, 600);
        }

        function playSynthBeat() {
            if (!audioCtx) return;
            // Kick Synth
            let osc = audioCtx.createOscillator();
            let gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            
            osc.frequency.setValueAtTime(150, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.8, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
            
            osc.start();
            osc.stop(audioCtx.currentTime + 0.15);

            // Snare/Hat Synth
            setTimeout(() => {
                if (!audioCtx) return;
                let noise = audioCtx.createOscillator();
                let noiseGain = audioCtx.createGain();
                noise.type = 'triangle';
                noise.connect(noiseGain);
                noiseGain.connect(audioCtx.destination);
                noise.frequency.setValueAtTime(1000, audioCtx.currentTime);
                noiseGain.gain.setValueAtTime(0.15, audioCtx.currentTime);
                noiseGain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);
                noise.start();
                noise.stop(audioCtx.currentTime + 0.05);
            }, 300);
        }

        window.addEventListener('click', startBeats);

        // Particle System
        const text = 'TEXT_TO_ANIMATE';
        
        function initText() {
            ctx.clearRect(0,0, canvas.width, canvas.height);
            const fontSize = Math.min(canvas.width / 6, 85);
            ctx.font = '900 ' + fontSize + 'px Outfit';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, canvas.width / 2, canvas.height / 2);
            
            const coords = ctx.getImageData(0, 0, canvas.width, canvas.height);
            particleArray = [];
            const step = Math.max(Math.floor(fontSize / 15), 4);
            
            for (let y = 0; y < canvas.height; y += step){
                for (let x = 0; x < canvas.width; x += step){
                    const alpha = coords.data[(y * 4 * coords.width) + (x * 4) + 3];
                    if (alpha > 128){
                        particleArray.push(new Particle(x, y));
                    }
                }
            }
        }

        class Particle {
            constructor(x, y){
                this.x = Math.random() * canvas.width;
                this.y = Math.random() * canvas.height;
                this.destX = x;
                this.destY = y;
                this.size = Math.random() * 2 + 1.5;
                this.baseSize = this.size;
                this.color = Math.random() > 0.5 ? selectedTheme.c1 : selectedTheme.c2;
                this.density = (Math.random() * 30) + 10;
                this.vx = 0;
                this.vy = 0;
            }
            draw() {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.size * beatPulse, 0, Math.PI * 2);
                ctx.closePath();
                ctx.fillStyle = this.color;
                ctx.fill();
            }
            update() {
                let dx = mouse.x - this.x;
                let dy = mouse.y - this.y;
                let distance = Math.sqrt(dx * dx + dy * dy);
                let forceDirectionX = dx / distance;
                let forceDirectionY = dy / distance;
                
                let maxDistance = mouse.radius;
                let force = (maxDistance - distance) / maxDistance;
                if (force < 0) force = 0;
                
                let directionX = forceDirectionX * force * this.density;
                let directionY = forceDirectionY * force * this.density;

                if (distance < mouse.radius) {
                    if (currentEffect === 'explode') {
                        this.vx -= directionX;
                        this.vy -= directionY;
                    } else if (currentEffect === 'vortex') {
                        this.vx += -directionY * 1.5;
                        this.vy += directionX * 1.5;
                    } else {
                        this.vx -= directionX * 0.8;
                        this.vy -= directionY * 0.8;
                    }
                } else {
                    let dxOrig = this.destX - this.x;
                    let dyOrig = this.destY - this.y;
                    this.vx += dxOrig * 0.08;
                    this.vy += dyOrig * 0.08;
                }
                
                this.vx *= 0.88;
                this.vy *= 0.88;
                this.x += this.vx;
                this.y += this.vy;
            }
        }

        function changeEffect(effect) {
            currentEffect = effect;
        }

        initText();
        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            initText();
        });

        function animate(){
            ctx.fillStyle = 'rgba(7, 11, 19, 0.2)';
            ctx.fillRect(0,0, canvas.width, canvas.height);
            
            // Decelerate the beat pulse back to base size
            beatPulse += (1.0 - beatPulse) * 0.1;

            for (let i = 0; i < particleArray.length; i++){
                particleArray[i].update();
                particleArray[i].draw();
            }
            requestAnimationFrame(animate);
        }
        animate();
    </script>
</body>
</html>
```

Ensure that you replace `TEXT_TO_ANIMATE` with the dynamic name or goodbye string uppercase, and escape the output cleanly so it conforms to standard JSON parsing inside the tool call.
