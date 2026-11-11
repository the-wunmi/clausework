import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Server-side secrets (ANTHROPIC_API_KEY) live in the repo-root .env, shared with the API.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const API_ORIGIN = process.env.CLAUSEWORK_API_ORIGIN ?? 'http://localhost:4100';

const config: NextConfig = {
  // The Docker image runs Next's standalone server, traced from the monorepo root.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? {
        output: 'standalone',
        outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
      }
    : {}),
  reactStrictMode: true,
  agentRules: false,
  devIndicators: false,
  typescript: {
    // Type checking runs through `pnpm typecheck` (tsc --noEmit), which uses the workspace compiler.
    ignoreBuildErrors: true,
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          // Portal links carry the party's token in the path; never send it to another site.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  async rewrites() {
    // A fallback rewrite runs only when no route matched, so /api/ai (the model proxy for AG
    // Studio, served by Next itself) never reaches the API.
    return { fallback: [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }] };
  },
};

export default config;
