# Node 24 LTS / Alpine 3.24. Pin the multi-platform index so every target uses
# the same reviewed npm bundle and OS packages. See docs/base-image-security.md.
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base
# The pinned image predates Alpine's CVE-2026-4738 fix. Apply it to all targets.
RUN apk add --no-cache --upgrade zlib=1.4-r0
# Update the complete supported npm 11 bundle: its dependencies are independent
# of /app/package-lock.json. glob/minimatch findings remain tracked in the docs.
RUN npm install --global --ignore-scripts npm@11.21.2 \
    && npm cache clean --force
WORKDIR /app

# Dependencies
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN --mount=type=cache,target=/root/.npm \
    npm ci
RUN npx prisma generate

# Dedicated migration image: the web/worker runtime stays free of Prisma CLI.
FROM deps AS migrate
COPY prisma.config.ts ./prisma.config.ts
CMD ["npx", "--no-install", "prisma", "migrate", "deploy"]

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# Runtime dependencies only. Install from a clean stage so npm does not retain
# Prisma's optional CLI peer or other development-only packages after pruning.
FROM base AS production-deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN npm pkg delete devDependencies
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --omit=peer
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# Runner
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# We need tsx to run the worker if running in worker mode
# Doing this before copying source code caches this layer
RUN npm install -g tsx@4.23.13

# Copy standalone files and static/public assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy source and config required by worker containers (npm run worker)
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/prisma ./prisma
COPY --from=production-deps /app/node_modules ./node_modules

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Default command for the web service
CMD ["node", "server.js"]
