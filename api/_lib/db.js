// /api/_lib/db.js
import pg from "pg";

const { Pool } = pg;

let _pool;

export function getPool() {
  if (_pool) return _pool;

  const conn =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL;

  if (!conn) {
    throw new Error("Brak DATABASE_URL w zmiennych środowiskowych na Vercel.");
  }

  _pool = new Pool({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
  });

  return _pool;
}
