FROM public.ecr.aws/docker/library/node:22-slim AS builder

ENV COREPACK_HOME=/corepack
ENV DATABASE_URL=postgresql://auto_ux@127.0.0.1:5432/auto_ux
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_BASE_PATH=/auto-ux

WORKDIR /app
COPY . .
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.30.0 --activate \
  && pnpm install --frozen-lockfile \
  && pnpm build

FROM public.ecr.aws/docker/library/node:22-slim AS runtime

ENV COREPACK_HOME=/corepack
ENV DATABASE_URL=postgresql://auto_ux@127.0.0.1:5432/auto_ux
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_BASE_PATH=/auto-ux
ENV NODE_ENV=production
ENV PORT=8080
ENV PATH=/usr/lib/postgresql/15/bin:$PATH

ARG GIT_COMMIT
LABEL org.opencontainers.image.revision=$GIT_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl openssl postgresql-15 postgresql-client-15 tini \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.30.0 --activate \
  && groupadd --system --gid 10001 auto-ux \
  && useradd --system --uid 10001 --gid 10001 --home-dir /home/auto-ux \
    --create-home --shell /usr/sbin/nologin auto-ux

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
