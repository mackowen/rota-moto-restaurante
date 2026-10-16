#!/data/data/com.termux/files/usr/bin/sh
set -eu

# Optional Termux:Boot template. Copy into ~/.termux/boot only after operator review.
SERVICE_DIRECTORY=${ROTAMOTO_RUNIT_SERVICE_DIRECTORY:-"$HOME/.local/share/rotamoto/runit/services"}
ROTAMOTO_BACKUP_EXECUTOR_ENV_FILE=${ROTAMOTO_BACKUP_EXECUTOR_ENV_FILE:-"$HOME/.config/rotamoto/backup-executor.env"}
export ROTAMOTO_BACKUP_EXECUTOR_ENV_FILE
mkdir -p "$SERVICE_DIRECTORY"
exec /data/data/com.termux/files/usr/bin/runsvdir -P "$SERVICE_DIRECTORY"
