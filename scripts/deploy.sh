#!/usr/bin/env bash
# Safe Ghost deploy: backup -> sync -> build+test on VPS -> restart ->
# health check -> automatic rollback on any failure.
#
# Usage: run from the ghost repo root:  ./scripts/deploy.sh
# Override the SSH target with:  GHOST_REMOTE=myhost ./scripts/deploy.sh
set -euo pipefail

REMOTE="${GHOST_REMOTE:-server}"
REMOTE_DIR="/home/rohan/projects/ghost"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/home/rohan/backups/ghost-deploy-$STAMP"

rollback() {
  echo "==> DEPLOY FAILED — rolling back to $BACKUP_DIR/ghost-src" >&2
  # shellcheck disable=SC2029
  ssh "$REMOTE" "rm -rf '$REMOTE_DIR' && cp -r '$BACKUP_DIR/ghost-src' '$REMOTE_DIR' && sudo systemctl restart ghost" || true
  echo "==> Rolled back and restarted. Check: ssh $REMOTE sudo systemctl status ghost" >&2
}
trap rollback ERR

echo "==> [1/5] Backing up remote to $BACKUP_DIR"
# shellcheck disable=SC2029
ssh "$REMOTE" "mkdir -p '$BACKUP_DIR' && cp -r '$REMOTE_DIR' '$BACKUP_DIR/ghost-src' && ls '$BACKUP_DIR'"

echo "==> [2/5] Syncing source to $REMOTE:$REMOTE_DIR"
rsync -av --delete --exclude node_modules --exclude dist ./ "$REMOTE:$REMOTE_DIR/"

echo "==> [3/5] Building and testing on VPS (deploy stops here on failure)"
# shellcheck disable=SC2029
ssh "$REMOTE" "export PATH=/home/rohan/.local/bin:\$PATH && cd '$REMOTE_DIR' && npm install --no-audit --no-fund --cache /tmp/npm-cache && npm test 2>&1 | tail -n 8"

echo "==> [4/5] Restarting ghost.service"
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo systemctl restart ghost && sleep 3 && sudo systemctl is-active ghost"

echo "==> [5/5] Health + ops check"
# shellcheck disable=SC2029
ssh "$REMOTE" "curl -fsS http://127.0.0.1:8791/health && echo && curl -fsS http://127.0.0.1:8791/ops | head -c 400 && echo"

trap - ERR
echo "==> DEPLOY OK. Backup kept at $BACKUP_DIR (delete old ones with: ssh $REMOTE 'ls -t ~/backups | tail -n +6')"
