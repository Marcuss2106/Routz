import type { NextConfig } from "next";

// Set ROUTZ_PHONE_HOST to the laptop's LAN IP to let an iPhone load the dev
// server (scripts/dev.sh sets it). Unset means localhost only.
const phoneHost = process.env.ROUTZ_PHONE_HOST?.trim();

const nextConfig: NextConfig = {
  ...(phoneHost ? { allowedDevOrigins: [phoneHost] } : {}),
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
