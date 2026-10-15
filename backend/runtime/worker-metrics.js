'use strict';

const BUCKETS_MS = Object.freeze([10, 50, 100, 250, 500, 1000]);
const WORKERS = new Set(['marketplace', 'logistics']);
const OUTCOMES = new Set(['processed', 'idle', 'error']);

function createWorkerMetrics({ now = () => Date.now() } = {}) {
  const startedAt = now();
  const rows = new Map();
  return Object.freeze({
    record({ worker, outcome, durationMs }) {
      const safeWorker = WORKERS.has(worker) ? worker : 'other';
      const safeOutcome = OUTCOMES.has(outcome) ? outcome : 'error';
      const key = `${safeWorker}|${safeOutcome}`;
      let row = rows.get(key);
      if (!row) {
        row = { runs: 0, durationMs: 0, maxDurationMs: 0, buckets: Object.fromEntries(BUCKETS_MS.map(ms => [`le_${ms}`, 0])) };
        row.buckets.gt_1000 = 0;
        rows.set(key, row);
      }
      const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
      row.runs += 1;
      row.durationMs += duration;
      row.maxDurationMs = Math.max(row.maxDurationMs, duration);
      const bucket = BUCKETS_MS.find(ms => duration <= ms);
      row.buckets[bucket ? `le_${bucket}` : 'gt_1000'] += 1;
    },
    snapshot() {
      const series = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => {
        const [worker, outcome] = key.split('|');
        return { worker, outcome, runs: row.runs, durationMs: Number(row.durationMs.toFixed(2)),
          maxDurationMs: Number(row.maxDurationMs.toFixed(2)), buckets: { ...row.buckets } };
      });
      return Object.freeze({ uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)), series });
    }
  });
}

module.exports = { createWorkerMetrics, BUCKETS_MS };
