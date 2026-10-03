import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    environment: "node",
  },
});
