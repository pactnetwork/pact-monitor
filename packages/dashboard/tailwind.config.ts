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
        serif: ["Inria Serif", "serif"],
        sans: ["Inria Sans", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
