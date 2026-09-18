FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Vite inlines env vars at build time, but this image is built once and run in
# many environments. So we build with sentinel placeholders (``__VITE_*__``)
# and rewrite them from the container's runtime environment on boot via
# ``env.sh`` (copied into /docker-entrypoint.d/ below). Add a new ``VITE_*`` var
# here and it is picked up automatically at runtime — no compose build args.
# Values MUST be supplied at runtime via Docker ``-e`` / compose ``environment:``.
ENV VITE_API_URL=__VITE_API_URL__
ENV VITE_BEEVER_API_KEY=__VITE_BEEVER_API_KEY__
ENV VITE_BEEVER_ADMIN_TOKEN=__VITE_BEEVER_ADMIN_TOKEN__

RUN npm run build

FROM nginxinc/nginx-unprivileged:alpine@sha256:85bcbc6b2edd325462560c597d784ecee415024f1c6a004e53ac5f202b8ca561
# Issue #39 — drop root. The `nginxinc/nginx-unprivileged` image is the official
# upstream nginx variant configured to run as the `nginx` user (UID 101) and
# listen on port 8080 by default. Avoids fragile manual chown of /var/cache/nginx,
# /var/run, /etc/nginx/conf.d that breaks across nginx version bumps. The host-side
# port mapping in docker-compose is updated atomically (3000:80 → 3000:8080).
# Own the assets as the unprivileged runtime user (UID 101) so env.sh can
# rewrite the __VITE_*__ sentinels in place at container start (sed -i needs
# write access to the files and their directory).
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html
# Runtime env injection: the official nginx entrypoint executes every script in
# /docker-entrypoint.d/ before launching nginx. env.sh rewrites the __VITE_*__
# sentinels baked into the bundle with values from the container environment.
COPY --chmod=755 env.sh /docker-entrypoint.d/40-env.sh
COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen 8080;
    root /usr/share/nginx/html;
    location / {
        try_files $uri $uri/ /index.html;
    }
    # Proxy API calls to the backend (avoids CORS issues in production)
    location /api/ {
        proxy_pass http://beever-atlas:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
