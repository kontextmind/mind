FROM oven/bun:1 AS base
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* \
    && git config --global --add safe.directory /mind
WORKDIR /app
COPY server/package.json server/
RUN cd server && (bun install --frozen-lockfile || bun install --no-save)
COPY server/ server/
COPY migrations/ migrations/
EXPOSE 3000
CMD ["sh", "-c", "cd server && bun run src/migrate.ts && bun run src/index.ts"]
