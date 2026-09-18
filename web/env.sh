#!/bin/sh
# Runtime injection of VITE_* env vars into the pre-built static bundle.
#
# Vite inlines env vars at BUILD time, but this image is built once and run in
# many environments. So the Dockerfile builds with sentinel placeholders
# (``__VITE_FOO__``) and this script rewrites them from the container's runtime
# environment on boot. Drop it in /docker-entrypoint.d/ — the official nginx
# entrypoint runs every script there before starting nginx.
#
# Pass values the normal Docker way and they are MANDATORY at runtime:
#     docker run -e VITE_API_URL=... -e VITE_BEEVER_API_KEY=...
# or via docker-compose ``environment:``. Any VITE_* found in the environment
# is picked up automatically — no need to edit this script for new vars.
#
# NOTE: these values ship in the browser bundle and are visible to anyone using
# the UI. They are NOT secrets.
set -eu

# Deliberately NOT prefixed VITE_ so it isn't swept up by the loop below.
ASSET_DIR="${RUNTIME_ASSET_DIR:-/usr/share/nginx/html}"

# 1. Replace the sentinel for every VITE_* var present in the environment.
for var in $(env | sed -n 's/^\(VITE_[A-Za-z0-9_]*\)=.*/\1/p'); do
    # BusyBox ash has no ${!var}; use eval for indirect expansion.
    value=$(eval "printf '%s' \"\${$var}\"")
    # Escape sed replacement metacharacters (\ & and the | delimiter).
    escaped=$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')
    find "$ASSET_DIR" -type f \( -name '*.js' -o -name '*.css' \) \
        -exec sed -i "s|__${var}__|${escaped}|g" {} +
    echo "env.sh: injected ${var}"
done

# 2. Collapse any sentinel left un-provided to an empty string so the app's own
#    ``|| default`` fallbacks (e.g. VITE_API_URL) still fire.
find "$ASSET_DIR" -type f \( -name '*.js' -o -name '*.css' \) \
    -exec sed -i 's|__VITE_[A-Za-z0-9_]*__||g' {} +
