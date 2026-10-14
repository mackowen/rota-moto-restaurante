'use strict';

const BUCKETS_MS = Object.freeze([10, 50, 100, 250, 500, 1000]);

function sanitizeLogPath(value) {
  const path = String(value || '').split('?')[0];
  return path.split('/').map(segment => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment) ||
    /^\d+$/u.test(segment) || segment.includes('@') ? ':id' : segment).join('/').slice(0, 180);
}

function createRuntimeMetrics({ now = () => Date.now() } = {}) {
  const startedAt = now();
  const counts = new Map();
  const durations = new Map();

  function keyFor(method, category, statusClass) {
    const safeMethod = /^[A-Z]{1,12}$/u.test(method) ? method : 'OTHER';
    const safeCategory = ['api', 'sync', 'health', 'other'].includes(category) ? category : 'other';
    const safeStatus = /^[1-5]xx$/u.test(statusClass) ? statusClass : '5xx';
    return `${safeMethod}|${safeCategory}|${safeStatus}`;
  }

  return Object.freeze({
    record({ method, category, status, durationMs }) {
      if (category === 'health' && method === 'GET') return;
      const key = keyFor(method, category, `${Math.floor(Number(status) / 100)}xx`);
      counts.set(key, (counts.get(key) || 0) + 1);
      const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
      let bucket = durations.get(key);
      if (!bucket) {
        bucket = { count: 0, sumMs: 0, maxMs: 0, buckets: Object.fromEntries(BUCKETS_MS.map(limit => [`le_${limit}ms`, 0])) };
        bucket.buckets.gt_1000ms = 0;
        durations.set(key, bucket);
      }
      bucket.count += 1;
      bucket.sumMs += duration;
      bucket.maxMs = Math.max(bucket.maxMs, duration);
      const limit = BUCKETS_MS.find(value => duration <= value);
      bucket.buckets[limit ? `le_${limit}ms` : 'gt_1000ms'] += 1;
    },
    snapshot() {
      const series = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, requests]) => {
        const [method, category, statusClass] = key.split('|');
        const duration = durations.get(key);
        return { method, category, statusClass, requests, durationMs: {
          count: duration.count, sum: Number(duration.sumMs.toFixed(2)), max: Number(duration.maxMs.toFixed(2)),
          buckets: { ...duration.buckets }
        } };
      });
      return Object.freeze({ uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)), series });
    }
  });
}

module.exports = { createRuntimeMetrics, BUCKETS_MS, sanitizeLogPath };
