import "@user-interface/env/web";
import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  typedRoutes: true,
  reactCompiler: true,
  turbopack: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
  },
};

export default nextConfig;
