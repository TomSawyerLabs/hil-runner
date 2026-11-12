# oven/bun:1.4.4-slim
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
USER bun
EXPOSE 8090
ENV BROKER_CONFIG=/config/broker.json
CMD ["bun", "src/main.ts"]
