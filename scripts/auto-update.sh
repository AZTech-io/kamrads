#!/bin/sh
# Keeps the server on the latest KAMRADS without anyone logging in: every 10 minutes it checks GitHub
# (with the server's own read-only deploy key) and rebuilds when main has changed.
#   Turn on (once, on the server):  cd /root/kamrads && git pull && sh scripts/auto-update.sh install
#   Turn off:                       sh /root/kamrads/scripts/auto-update.sh uninstall
#   Log:                            /root/kamrads/data/auto-update.log
set -u
DIR=$(cd "$(dirname "$0")/.." && pwd)
LOG="$DIR/data/auto-update.log"
case "${1:-run}" in
  install)
    ( crontab -l 2>/dev/null | grep -v 'kamrads.*auto-update.sh'
      echo "*/10 * * * * flock -n /tmp/kamrads-update.lock sh $DIR/scripts/auto-update.sh >> $LOG 2>&1" ) | crontab -
    echo ">> Auto-update is on: KAMRADS checks GitHub every 10 minutes and rebuilds when there's a new version."
    cd "$DIR" && docker compose up -d --build && docker image prune -f >/dev/null
    ;;
  uninstall)
    crontab -l 2>/dev/null | grep -v 'kamrads.*auto-update.sh' | crontab -
    echo ">> Auto-update is off."
    ;;
  run)
    cd "$DIR" || exit 0
    [ -f "$LOG" ] && tail -n 400 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
    git fetch -q origin main || exit 0
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
    echo "$(date '+%F %T') updating $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
    git reset -q --hard origin/main && docker compose up -d --build && docker image prune -f >/dev/null && echo "$(date '+%F %T') done"
    ;;
esac
