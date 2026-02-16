// api/admin-api/login.js  — Funkcja #6
// POST /api/admin-api/login  { username, password } → { token }
const { getPool } = require('../_lib/db');
const bcrypt = require('bcryptjs');

// Prosty JWT bez zewnętrznych lib
function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function makeJWT(payload, secret) {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const body   = base64url(payload);
  const crypto = require('crypto');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const pool = getPool();
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Podaj login i hasło.' });
    }

    // Pobierz usera
    const { rows: [user] } = await pool.query(
      `SELECT id, username, password_hash FROM admin_users WHERE username = $1`,
      [username]
    );

    if (!user) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

    // Sprawdź hasło
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('Brak JWT_SECRET w env');

    const token = makeJWT(
      { sub: user.id, username: user.username, iat: Math.floor(Date.now()/1000) },
      secret
    );

    return res.status(200).json({ token, username: user.username });

  } catch (e) {
    console.error('[admin/login]', e);
    return res.status(500).json({ error: e.message });
  }
};
