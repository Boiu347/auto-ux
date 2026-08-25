FROM public.ecr.aws/docker/library/node:22-slim AS runtime-base

ENV COREPACK_HOME=/corepack
ENV DATABASE_URL=postgresql://auto_ux@127.0.0.1:5432/auto_ux
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_BASE_PATH=/auto-ux
ENV PATH=/usr/lib/postgresql/15/bin:$PATH

RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
  && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install \
    -y --no-install-recommends curl openssl postgresql-15 postgresql-client-15 tini \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.30.0 --activate \
  && groupadd --system --gid 10001 auto-ux \
  && useradd --system --uid 10001 --gid 10001 --home-dir /home/auto-ux \
    --create-home --shell /usr/sbin/nologin auto-ux

FROM runtime-base AS builder

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build

FROM runtime-base AS runtime

ENV NODE_ENV=production
ENV PORT=8080

ARG GIT_COMMIT
LABEL org.opencontainers.image.revision=$GIT_COMMIT

WORKDIR /app
COPY --from=builder --chown=10001:10001 /app /app
COPY --chown=10001:10001 docker-entrypoint.sh /usr/local/bin/auto-ux-entrypoint
RUN chmod 0755 /usr/local/bin/auto-ux-entrypoint \
  && install -d -o 10001 -g 10001 -m 0750 /data

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=6 \
  CMD ["curl", "--fail", "--silent", "http://127.0.0.1:8080/api/health"]

USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/auto-ux-entrypoint"]
