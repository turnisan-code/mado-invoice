import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const noIndex = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];

const nextConfig: NextConfig = {
  // The PDF renderer reads its fonts from disk (src/lib/pdf/render.ts); files in public/ are
  // served by the CDN and are not part of a serverless function unless traced in here.
  outputFileTracingIncludes: {
    "/api/**": ["./public/fonts/*"],
    "/portal/**": ["./public/fonts/*"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/portal/:path*", headers: noIndex },
      { source: "/login", headers: noIndex },
    ];
  },
};

export default nextConfig;
