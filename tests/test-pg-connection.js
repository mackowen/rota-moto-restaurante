'use strict';

const assert = require('node:assert/strict');
const { withExplicitPassword, createClient } = require('../backend/postgres/connection');

const target = process.env.PG_CONNECTION_TEST_URL || 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e';
const options = withExplicitPassword({ connectionString: target });
assert.equal(typeof options.password, 'function', 'password must always be explicitly resolved before pg receives config');
assert.equal(options.password instanceof Function, true, 'password must not be embedded into the connection URL');

if (process.env.PG_CONNECTION_TEST !== '1') {
  process.stdout.write('PostgreSQL connection password callback regression guard: PASS (unit)\n');
} else {
  (async () => {
    const client = createClient({ connectionString: target, connectionTimeoutMillis: 5000 });
    const warning = warningValue => {
      if (warningValue.name === 'DeprecationWarning' && /pgpass support is deprecated/u.test(warningValue.message)) {
        throw new Error('pgpass deprecation warning returned; pg@9 callback compatibility regressed.');
      }
    };
    process.on('warning', warning);
    try {
      await client.connect();
      await client.query('SELECT 1');
    } finally {
      process.removeListener('warning', warning);
      await client.end();
    }
    process.stdout.write('PostgreSQL connection password callback regression guard: PASS (live E2E)\n');
  })().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
