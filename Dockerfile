FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
USER bun
CMD ["bun", "src/main.ts"]

FROM runtime AS validation
COPY tests ./tests

FROM runtime AS production
