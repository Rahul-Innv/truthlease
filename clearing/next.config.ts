import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Secrets never reach the browser: only NEXT_PUBLIC_* would, and we define none.
  poweredByHeader: false,
};

export default nextConfig;
