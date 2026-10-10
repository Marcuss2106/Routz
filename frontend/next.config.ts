import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Keep the dev badge off the bottom route bar. */
  devIndicators: { position: "top-right" },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
