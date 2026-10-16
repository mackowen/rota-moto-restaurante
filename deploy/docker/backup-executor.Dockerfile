FROM node:24-bookworm-slim

ARG BACKUP_UID=10001
ARG BACKUP_GID=10002
WORKDIR /opt/rotamoto
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    groupadd --gid "${BACKUP_GID}" backup-control && \
    useradd --uid "${BACKUP_UID}" --gid "${BACKUP_GID}" --home-dir /nonexistent --shell /usr/sbin/nologin backup-executor && \
    install -d -o "${BACKUP_UID}" -g "${BACKUP_GID}" -m 2770 /var/lib/rotamoto/backup-control /var/lib/rotamoto/recovery-sets /var/lib/rotamoto/media /var/log/rotamoto
COPY backend ./backend
COPY migrations ./migrations
COPY scripts/backup-executor.js scripts/backup-executor-health.js ./scripts/
USER ${BACKUP_UID}:${BACKUP_GID}
ENV NODE_ENV=production ROTAMOTO_BACKUP_EXECUTOR_UID=${BACKUP_UID} ROTAMOTO_BACKUP_CONTROL_GROUP_GID=${BACKUP_GID}
VOLUME ["/var/lib/rotamoto/backup-control", "/var/lib/rotamoto/recovery-sets", "/var/lib/rotamoto/media"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD ["node", "scripts/backup-executor-health.js"]
ENTRYPOINT ["node", "scripts/backup-executor.js"]
