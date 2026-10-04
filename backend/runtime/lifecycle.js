'use strict';

function gracefulShutdown({ server, pool, timeoutMs = 10_000, onTimeout = () => {} }) {
  let timer;
  const drained = new Promise(resolve => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    timer = setTimeout(() => {
      onTimeout();
      server.closeAllConnections?.();
      resolve();
    }, timeoutMs);
  });
  return drained.then(async () => {
    clearTimeout(timer);
    await pool.end();
  });
}

module.exports = { gracefulShutdown };
