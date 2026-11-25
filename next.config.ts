import type { NextConfig } from "next";

// Nagłówki bezpieczeństwa. CSP z nonce jest generowane per żądanie w `proxy.ts`.
const isDev = process.env.NODE_ENV !== "production";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Samodzielny build: obraz Dockera zawiera tylko serwer i niezbędne zależności.
  output: "standalone",
  // Moduły natywne (.node) muszą trafić do outputu — tracer Nexta nie zawsze je łapie.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/better-sqlite3/**", "./node_modules/@node-rs/argon2/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
