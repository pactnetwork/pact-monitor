import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://localhost:${process.env.BACKEND_PORT || "3001"}`,
      "/health": `http://localhost:${process.env.BACKEND_PORT || "3001"}`,
    },
  },
});
