import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#151311",
        copper: "#B87333",
        sienna: "#C9553D",
        slate: "#5A6B7A",
      },
      fontFamily: {
        serif: ["var(--font-inria-serif)", "serif"],
        sans: ["var(--font-inria-sans)", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
