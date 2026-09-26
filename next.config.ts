import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin pulls in jwks-rsa -> jose (ESM-only since jose v5+). Bundling these into the server route
  // compilation (Turbopack or webpack) breaks at runtime with ERR_REQUIRE_ESM, because the bundler's own
  // require() shim can't load an ESM module the way Node's native resolution can. Leaving them external makes
  // Next hand off to Node's real require()/import() at runtime instead of bundling them.
  serverExternalPackages: ["firebase-admin", "jwks-rsa", "jose"],
};

export default nextConfig;
