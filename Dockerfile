# ─── Build stage: compile TypeScript ────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY tests/ ./tests/

RUN npx tsc --noEmit && echo "TypeScript check passed"

# ─── Runtime stage: slim production image ───────────────────────────
FROM node:20-alpine

WORKDIR /app

# Create non-root user
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

COPY tsconfig.json ./
COPY src/ ./src/

# Use tsx for runtime (no build step — runs TypeScript directly)
RUN npm install -g tsx

USER app
EXPOSE 8080

ENV GATEWAY_PORT=8080
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["tsx", "src/gateway.ts"]
