#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
origin="${1:-}"
case "$origin" in
  http://*|https://*) ;;
  *) echo 'Usage: ./scripts/deploy.sh http://YOUR_VM_IP:3000' >&2; exit 1;;
esac
# Keep the dotenv value single-line and shell-free; no eval or sourced .env.
case "$origin" in *[!a-zA-Z0-9.:/-]*|*/) echo 'Use a plain origin without trailing slash, query or credentials.' >&2; exit 1;; esac
authority="${origin#*://}"
case "$authority" in ''|*/*) echo 'Use an origin such as http://192.168.1.50:3000, without a path.' >&2; exit 1;; esac
if [ ! -f .env ]; then
  umask 077
  secret=$(openssl rand -hex 32)
  secure=false
  case "$origin" in https://*) secure=true;; esac
  cat > .env <<ENV
POSTGRES_PASSWORD=$secret
PUBLIC_ORIGIN=$origin
COOKIE_SECURE=$secure
TRUST_PROXY=false
MESSAGE_RATE_LIMIT=120
PORT=3000
BIND_IP=0.0.0.0
ELASTICSEARCH_URL=
ENV
fi
docker compose up -d --build
docker compose ps
printf '\nConfigured URL: %s (PUBLIC_ORIGIN in existing .env takes precedence)\n' "$origin"
