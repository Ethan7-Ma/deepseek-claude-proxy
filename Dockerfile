FROM node:20-alpine

WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsx --eval "import './src/proxy.js'" 2>/dev/null; true

RUN npm install -g tsx

USER app
EXPOSE 8080

ENV PROXY_PORT=8080
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["tsx", "src/proxy.ts"]
