FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock* ./
COPY server/package.json server/
RUN bun install --frozen-lockfile || bun install
COPY server/ server/
COPY migrations/ migrations/
EXPOSE 3000
CMD ["bun", "run", "server/src/index.ts"]
