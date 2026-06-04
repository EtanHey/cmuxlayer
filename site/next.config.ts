import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Pin Turbopack's root to this site directory. The repo root holds its own
// package-lock.json (for the MCP server), so Next.js infers the monorepo root
// as the workspace root via lockfile detection and then scans repo-root `src/`
// for the `proxy.ts` file convention (the renamed middleware) — picking up the
// MCP edge proxy at `../src/proxy.ts` and failing the build. Pinning the root
// keeps Next's file-convention scanning and module resolution inside `site/`.
const siteRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: siteRoot,
  },
};

export default nextConfig;
