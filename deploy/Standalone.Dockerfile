FROM rust:1.92.0-bookworm@sha256:e90e846de4124376164ddfbaab4b0774c7bdeef5e738866295e5a90a34a307a2 AS native
RUN apt-get update && apt-get install -y --no-install-recommends clang libclang-dev cmake pkg-config protobuf-compiler && rm -rf /var/lib/apt/lists/*
COPY --from=myelin /myelin-source.tar /tmp/myelin-source.tar
COPY deploy/myelin-source.sha256 /tmp/myelin-source.sha256
RUN cd /tmp && sha256sum --strict -c myelin-source.sha256 && mkdir -p /src/Myelin && tar -xf myelin-source.tar -C /src/Myelin && rm myelin-source.tar
WORKDIR /src/chess
COPY games ./games
COPY tests ./tests
ARG CARGO_BUILD_JOBS=4
RUN --mount=type=cache,id=myelin-games-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=myelin-games-rust-1.92.0-release,target=/build-target,sharing=locked \
    cargo build --release --locked --jobs "${CARGO_BUILD_JOBS}" --manifest-path games/chess/Cargo.toml --target-dir /build-target && \
    install -D /build-target/release/myelin-chess /out/myelin-chess
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 zlib1g && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=web /src/dist ./dist
COPY host ./host
COPY game-host.json ./game-host.json
COPY deploy/myelin-source.sha256 ./myelin-source.sha256
COPY --from=native /out/myelin-chess ./target/release/myelin-chess
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production BIND=0.0.0.0 WEB_PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "host/start.mjs"]
