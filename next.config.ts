import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["otoserve10", "otoserve10:3000", "otoserve10:3001"],
  reactStrictMode: true,
  serverExternalPackages: ["sharp"],
  // splat-viewer is consumed as a git dependency whose entry is TS/TSX
  // source (github:gitcapoom/splat-viewer). Next must transpile it.
  transpilePackages: ["splat-viewer"],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
