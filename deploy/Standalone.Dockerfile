FROM rust:1.97.1-bookworm AS native
RUN apt-get update && apt-get install -y --no-install-recommends clang libclang-dev pkg-config protobuf-compiler && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY games ./games
COPY tests ./tests
RUN cargo build --release --locked --manifest-path games/chess/Cargo.toml --target-dir target
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 zlib1g && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=web /src/dist ./dist
COPY host ./host
COPY game-host.json ./game-host.json
COPY --from=native /src/target/release/myelin-chess ./target/release/myelin-chess
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production BIND=0.0.0.0 WEB_PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "host/start.mjs"]
