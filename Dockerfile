# Node 24 LTS / Alpine 3.24. Pin the multi-platform index so every target uses
# the same reviewed Node and OS packages. See docs/base-image-security.md.
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base
# The pinned image predates Alpine's CVE-2026-4738 fix. Apply it to all targets.
RUN apk add --no-cache --upgrade zlib=1.4-r0
WORKDIR /app

FROM base AS build-base
RUN npm install --global --ignore-scripts npm@11.21.2 \
    && npm cache clean --force

# Package managers are needed only while building the image. The entrypoint
# translates the existing Docker commands to their already-installed programs.
FROM base AS final-base
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chmod=755 docker/mailhub-entrypoint.sh /usr/local/bin/mailhub-entrypoint
ENTRYPOINT ["/usr/local/bin/mailhub-entrypoint"]

# Dependencies
FROM build-base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN --mount=type=cache,target=/root/.npm \
    npm ci
RUN npx prisma generate

# Dedicated migration image: the web/worker runtime stays free of Prisma CLI.
FROM final-base AS migrate
COPY --from=deps /app ./
COPY prisma.config.ts ./prisma.config.ts
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy"]

# Build
FROM build-base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# Runtime dependencies only. Install from a clean stage so npm does not retain
# Prisma's optional CLI peer or other development-only packages after pruning.
FROM build-base AS production-deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN npm pkg delete devDependencies
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --omit=peer
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

FROM build-base AS worker-tools
RUN npm install --global tsx@4.23.13

# Runner
FROM final-base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=worker-tools /usr/local/lib/node_modules/tsx /usr/local/lib/node_modules/tsx
RUN ln -s ../lib/node_modules/tsx/dist/cli.mjs /usr/local/bin/tsx

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
