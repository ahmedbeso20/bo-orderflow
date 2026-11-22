import type { NextConfig } from 'next';

const API_ORIGIN = (process.env.API_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_ORIGIN}/api/:path*`
      },
      {
        source: '/invoice/:path*',
        destination: `${API_ORIGIN}/invoice/:path*`
      },
      {
        source: '/receipt/:path*',
        destination: `${API_ORIGIN}/receipt/:path*`
      }
    ];
  }
};

export default nextConfig;
