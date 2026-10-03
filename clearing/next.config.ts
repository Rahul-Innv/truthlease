import type { NextConfig } from "next";
import path from "node:path";

/**
 * Browser-runtime builds (NEXT_PUBLIC_CLEARING_RUNTIME=browser) run the service in the page. The page
 * imports store.ts only for its shared error classes; its Node-only imports are stubbed for the browser
 * condition and never called there. Server-mode builds are unchanged (no alias).
 */
const browserRuntime = process.env.NEXT_PUBLIC_CLEARING_RUNTIME === "browser";
const browserNodeStub = "./src/lib/browser-node-stub.ts";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Always defined at build time ("server" unless set), so the browser-runtime branch is folded away and its
  // chunk (which carries the private demo seller policies) is never emitted by server-mode builds.
  env: { NEXT_PUBLIC_CLEARING_RUNTIME: browserRuntime ? "browser" : "server" },
  // Secrets never reach the browser: only NEXT_PUBLIC_* would, and we define none.
  poweredByHeader: false,
  // This app lives inside another repository that has its own lockfile; pin the workspace root.
  turbopack: {
    root: path.resolve(import.meta.dirname),
    ...(browserRuntime ? { resolveAlias: { "node:fs": { browser: browserNodeStub }, "node:path": { browser: browserNodeStub } } } : {}),
  },
  // Loaded at runtime from node_modules (dynamic import, only when BAND is configured).
  serverExternalPackages: ["@band-ai/sdk"],
};

export default nextConfig;
