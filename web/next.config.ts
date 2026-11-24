import type { NextConfig } from 'next';

const API_ORIGIN = (process.env.API_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ALLOW_IFRAME = process.env.ALLOW_IFRAME === '1' || process.env.ALLOW_IFRAME === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';

const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ALLOW_IFRAME ? 'frame-ancestors *' : "frame-ancestors 'none'"
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: cspDirectives },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ...(ALLOW_IFRAME ? [] : [{ key: 'X-Frame-Options', value: 'DENY' }]),
  ...(IS_PROD ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' }] : [])
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    root: __dirname
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders
      }
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_ORIGIN}/api/:path*`
      }
    ];
  }
};

export default nextConfig;
