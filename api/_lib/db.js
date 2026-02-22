// api/_lib/db.js  — CommonJS (NIE ESM, bo handlery używają require)
const { Pool } = require('pg');

let _pool;

function getPool() {
  if (_pool) return _pool;

  const conn =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL;

  if (!conn) throw new Error('Brak DATABASE_URL w zmiennych środowiskowych.');

  _pool = new Pool({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });

  return _pool;
}

module.exports = { getPool };
