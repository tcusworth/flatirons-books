import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // postgres.js is a server-only ES module; keep it out of the bundler.
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  async rewrites() {
    // OAuth discovery documents for the MCP connector.
    return [{ source: "/.well-known/:path*", destination: "/api/well-known/:path*" }];
  },
};

export default nextConfig;
