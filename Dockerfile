FROM oven/bun:1.3.3

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY fixtures ./fixtures

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER bun
EXPOSE 8080
CMD ["bun", "src/server.ts"]
