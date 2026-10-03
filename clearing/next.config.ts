import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Secrets never reach the browser: only NEXT_PUBLIC_* would, and we define none.
  poweredByHeader: false,
  // This app lives inside another repository that has its own lockfile; pin the workspace root.
  turbopack: { root: path.resolve(import.meta.dirname) },
};

export default nextConfig;
