import type { Config } from "tailwindcss";

const config: Config = {
    content: [
        "./pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            fontFamily: {
                orbitron: ['Orbitron', 'sans-serif'],
                rajdhani: ['Rajdhani', 'sans-serif'],
            },
            colors: {
                'jarvis-cyan': '#00f3ff',
                'jarvis-blue': '#0080ff',
                'jarvis-purple': '#b000ff',
                'jarvis-dark': '#0a0e27',
                'jarvis-darker': '#050816',
            },
        },
    },
    plugins: [],
};

export default config;
