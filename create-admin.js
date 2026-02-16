// create-admin.js — uruchom lokalnie: node create-admin.js
// Tworzy pierwsze konto admina w bazie
// WYMAGA: DATABASE_URL w .env lub jako zmienna środowiskowa

require('dotenv').config(); // opcjonalnie, jeśli masz .env
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const USERNAME = process.argv[2] || 'admin';
const PASSWORD = process.argv[3] || 'zmien-mnie-123!';

async function main() {
  if (PASSWORD === 'zmien-mnie-123!') {
    console.warn('⚠️  Używasz domyślnego hasła! Użyj: node create-admin.js admin TwojeHaslo');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const hash = await bcrypt.hash(PASSWORD, 12);
    const { rows: [u] } = await pool.query(
      `INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id, username`,
      [USERNAME, hash]
    );
    console.log(`✅ Admin utworzony/zaktualizowany: ID=${u.id}, username="${u.username}"`);
  } catch (e) {
    console.error('❌ Błąd:', e.message);
  } finally {
    await pool.end();
  }
}

main();
