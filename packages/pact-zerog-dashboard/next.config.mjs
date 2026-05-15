/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @0gfoundation/0g-storage-ts-sdk is Node-only and must never reach the client bundle.
  // The dashboard reads evidence via the indexer REST API, not directly from the SDK.
  serverExternalPackages: ['@0gfoundation/0g-storage-ts-sdk'],
};

export default nextConfig;
