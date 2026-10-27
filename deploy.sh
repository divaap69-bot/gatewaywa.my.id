#!/usr/bin/env bash
# Deploy di VPS: tarik kode terbaru, install dependency, reload PM2, cek /health.
# Pemakaian: cd ~/apps/gatewaywa && ./deploy.sh [branch]
# Folder storage/ (sesi WhatsApp), logs/, dan .env TIDAK disentuh.
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="gatewaywa"
BRANCH="${1:-main}"
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
HEALTH_URL="http://127.0.0.1:${PORT:-3000}/health"

log()  { echo -e "\033[1;34m[deploy]\033[0m $*"; }
fail() { echo -e "\033[1;31m[deploy] GAGAL:\033[0m $*" >&2; exit 1; }
trap 'fail "baris $LINENO: perintah \"$BASH_COMMAND\" error"' ERR

cd "$APP_DIR"
[ -f .env ] || fail ".env belum ada di $APP_DIR. Salin dari .env.example lalu isi."
command -v pm2 >/dev/null || fail "pm2 belum terpasang (npm i -g pm2)."

PREV_COMMIT="$(git rev-parse --short HEAD)"
log "Commit sekarang: $PREV_COMMIT, tarik origin/$BRANCH..."
git fetch --prune origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"   # VPS tidak boleh diedit manual; samakan persis dengan remote
NEW_COMMIT="$(git rev-parse --short HEAD)"
log "Commit baru: $NEW_COMMIT"

log "Install dependency (production)..."
npm ci --omit=dev --no-audit --no-fund

if npm run | grep -qE '^  build$'; then
  log "Build..."
  npm run build
fi

mkdir -p logs storage

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  log "Reload PM2..."
  pm2 reload ecosystem.config.cjs --update-env
else
  log "App belum ada di PM2, start pertama kali..."
  pm2 start ecosystem.config.cjs
fi
pm2 save >/dev/null

log "Cek health di $HEALTH_URL ..."
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    log "Sehat: $(curl -fsS --max-time 3 "$HEALTH_URL")"
    log "Deploy $PREV_COMMIT -> $NEW_COMMIT selesai."
    exit 0
  fi
  sleep 2
done

trap - ERR
echo "----- 30 baris log terakhir -----" >&2
pm2 logs "$APP_NAME" --lines 30 --nostream >&2 || true
fail "Health check tidak OK setelah 40 detik. Rollback: git checkout $PREV_COMMIT && npm ci --omit=dev && pm2 reload $APP_NAME"
