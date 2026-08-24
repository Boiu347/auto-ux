FROM python:3.12-slim AS builder

ENV COREPACK_HOME=/corepack
ENV DATABASE_URL=postgresql://auto_ux@127.0.0.1:5432/auto_ux
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_BASE_PATH=/auto-ux

WORKDIR /app
COPY . .
RUN apt-get update \
  && apt-get install -y --no-install-recommends node-corepack nodejs openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack prepare pnpm@10.30.0 --activate \
  && chmod 0755 /corepack/pnpm/10.30.0/bin/pnpm.cjs \
  && ln -sf /corepack/pnpm/10.30.0/bin/pnpm.cjs /usr/local/bin/pnpm \
  && pnpm install --frozen-lockfile \
  && pnpm build

FROM python:3.12-slim AS runtime

ENV COREPACK_HOME=/corepack
ENV DATABASE_URL=postgresql://auto_ux@127.0.0.1:5432/auto_ux
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_BASE_PATH=/auto-ux
ENV NODE_ENV=production
ENV PORT=8080
ENV PATH=/usr/lib/postgresql/17/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl gosu node-corepack nodejs openssl postgresql postgresql-client tini \
  && rm -rf /var/lib/apt/lists/* \
  && corepack prepare pnpm@10.30.0 --activate \
  && chmod 0755 /corepack/pnpm/10.30.0/bin/pnpm.cjs \
  && ln -sf /corepack/pnpm/10.30.0/bin/pnpm.cjs /usr/local/bin/pnpm \
  && groupadd --gid 1000 node \
  && useradd --uid 1000 --gid node --shell /bin/sh --create-home node

WORKDIR /app
COPY --from=builder --chown=node:node /app /app
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/auto-ux-entrypoint
RUN chmod 0755 /usr/local/bin/auto-ux-entrypoint \
  && mkdir -p /app/data \
  && chown node:node /app/data

EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=6 \
  CMD ["curl", "--fail", "--silent", "http://127.0.0.1:8080/api/health"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/auto-ux-entrypoint"]
