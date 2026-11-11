# syntax=docker/dockerfile:1.7
# One file, two images: `--target api` and `--target web`. docker-compose.yml builds both.

# Pinned to a digest so a rebuilt tag cannot change what runs. Bump deliberately.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# ── Shared: pnpm, and every dependency fetched once from the lockfile ─────────────────────────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN corepack install
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

# ── API: TypeScript run by tsx, production dependencies only ─────────────────────────────────
FROM fetch AS api-deps
COPY packages/core/package.json packages/core/
COPY packages/billing/package.json packages/billing/
COPY packages/db/package.json packages/db/
COPY packages/agents/package.json packages/agents/
COPY packages/paypal/package.json packages/paypal/
COPY packages/engine/package.json packages/engine/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --prod --filter "@clausework/api..."

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps --chown=root:root /app ./
COPY --chown=root:root packages ./packages
COPY --chown=root:root apps/api ./apps/api
# The engine reads the sample agreements from here.
COPY --chown=root:root samples ./samples
WORKDIR /app/apps/api
ENV PATH=/app/apps/api/node_modules/.bin:$PATH
# Files stay root-owned and read-only to the process; it writes only to the database.
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node_modules/.bin/tsx", "src/server.ts"]

# ── Web: Next.js standalone build ────────────────────────────────────────────────────────────
FROM fetch AS web-build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@clausework/web..."
# Built into the page, so they are build arguments, not runtime settings. None of them is secret.
ARG NEXT_PUBLIC_AG_GRID_LICENSE=
ARG NEXT_PUBLIC_AG_STUDIO_LICENSE=
# The API's address from the web container; Next fixes its rewrites at build time.
ARG CLAUSEWORK_API_ORIGIN=http://api:4100
ENV NEXT_PUBLIC_AG_GRID_LICENSE=$NEXT_PUBLIC_AG_GRID_LICENSE \
    NEXT_PUBLIC_AG_STUDIO_LICENSE=$NEXT_PUBLIC_AG_STUDIO_LICENSE \
    CLAUSEWORK_API_ORIGIN=$CLAUSEWORK_API_ORIGIN \
    NEXT_OUTPUT=standalone
RUN pnpm --filter @clausework/web exec next build --webpack

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=web-build --chown=root:root /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=root:root /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
