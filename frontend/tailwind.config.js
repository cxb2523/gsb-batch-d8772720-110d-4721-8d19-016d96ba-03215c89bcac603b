/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "SF Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        base: {
          950: "#0a0b0f",
          900: "#0f1117",
          800: "#151821",
          700: "#1e2230",
          600: "#2a2f42",
        },
        accent: {
          400: "#a78bfa",
          500: "#8b5cf6",
        },
      },
    },
  },
  plugins: [],
};
