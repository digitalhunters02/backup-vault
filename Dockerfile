# backup-vault - stateless PostgreSQL backups to S3-compatible storage.
FROM node:22-alpine

# pg_dump MUST be the same major version as the database server, or newer.
# By default we install the NEWEST postgresqlNN-client that this Alpine release offers.
# To pin another one (build argument / Coolify "Build Variable"):  PG_CLIENT_PACKAGE=postgresql16-client
ARG PG_CLIENT_PACKAGE=""

RUN set -eux; \
    apk update; \
    apk add --no-cache tzdata ca-certificates; \
    pkg="${PG_CLIENT_PACKAGE}"; \
    if [ -z "$pkg" ]; then \
      pkg="$(apk search -q 'postgresql*-client' | grep -E '^postgresql[0-9]+-client$' | sort -V | tail -n1)"; \
    fi; \
    test -n "$pkg"; \
    echo "Installing $pkg"; \
    apk add --no-cache "$pkg"; \
    # versioned Alpine packages keep the tools in /usr/libexec/postgresqlNN/ : expose them on PATH
    dir="$(ls -d /usr/libexec/postgresql[0-9]* 2>/dev/null | sort -V | tail -n1 || true)"; \
    if [ -n "$dir" ]; then for b in pg_dump pg_restore psql; do if [ -x "$dir/$b" ]; then ln -sf "$dir/$b" "/usr/local/bin/$b"; fi; done; fi; \
    pg_dump --version; pg_restore --version; \
    rm -rf /var/cache/apk/*

ENV NODE_ENV=production \
    PORT=4000 \
    TZ=America/Denver

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" | grep -q '"ok":true' || exit 1

CMD ["node", "src/server.js"]
