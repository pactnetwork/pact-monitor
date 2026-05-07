import type { NextConfig } from "next";

// Standalone output — required for Cloud Run image (`node server.js`).
// Next.js bundles a minimal node_modules + package.json into
// `.next/standalone/` so the runtime stage doesn't need pnpm install.
const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
