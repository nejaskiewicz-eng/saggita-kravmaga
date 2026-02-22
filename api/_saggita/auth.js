// api/instructor/auth.js  — FUNKCJA #10
// POST /api/instructor/login  → { token, instructor }
// GET  /api/instructor/me     → dane zalogowanego instruktora

const { getPool } = require('../_lib/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeJWT(payload, secret) {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const body   = base64url(payload);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token, secret) {
  if (!token) throw new Error('Brak tokenu');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Nieprawidłowy format tokenu');
  const [header, payload, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  if (sig !== expected) throw new Error('Nieważny token');
  const pad = payload.length % 4;
  const padded = pad ? payload + '='.repeat(4 - pad) : payload;
  return JSON.parse(Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

function getInstructor(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Brak JWT_SECRET');
  const payload = verifyJWT(token, secret);
  if (payload.role !== 'instructor') throw new Error('Brak uprawnień instruktora');
  return payload;
}

module.exports = { getInstructor };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const pool = getPool();
  const route = req.query._route;

  // ── GET /api/instructor/me ────────────────────────────────────
  if (req.method === 'GET' && route === 'me') {
    try {
      const payload = getInstructor(req);
      const { rows: [instructor] } = await pool.query(`
        SELECT id, username, first_name, last_name, email, phone,
          COALESCE(json_agg(
            json_build_object('id', g.id, 'name', g.name, 'category', g.category)
          ) FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
        FROM instructors i
        LEFT JOIN instructor_groups ig ON ig.instructor_id = i.id
        LEFT JOIN groups g ON g.id = ig.group_id AND g.active = true
        WHERE i.id = $1 AND i.active = true
        GROUP BY i.id
      `, [payload.sub]);
      if (!instructor) return res.status(401).json({ error: 'Instruktor nie znaleziony.' });
      return res.status(200).json(instructor);
    } catch (e) {
      return res.status(401).json({ error: e.message });
    }
  }

  // ── POST /api/instructor/login ────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'Podaj login i hasło.' });
      }

      const { rows: [instructor] } = await pool.query(
        `SELECT id, username, password_hash, first_name, last_name FROM instructors WHERE username = $1 AND active = true`,
        [username]
      );
      if (!instructor) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

      const ok = await bcrypt.compare(password, instructor.password_hash);
      if (!ok) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error('Brak JWT_SECRET w env');

      const token = makeJWT({
        sub: instructor.id,
        username: instructor.username,
        role: 'instructor',  // ← kluczowe: odróżnia od admina
        iat: Math.floor(Date.now() / 1000),
      }, secret);

      return res.status(200).json({
        token,
        instructor: {
          id: instructor.id,
          username: instructor.username,
          first_name: instructor.first_name,
          last_name: instructor.last_name,
        },
      });
    } catch (e) {
      console.error('[instructor/login]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

// Eksportuj helper dla innych modułów
module.exports.getInstructor = getInstructor;
