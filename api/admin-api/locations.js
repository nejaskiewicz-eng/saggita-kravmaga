// api/admin-api/locations.js
// GET  /api/admin-api/locations → lista lokalizacji
// POST /api/admin-api/locations → nowa lokalizacja
const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();

  // ── GET lista lokalizacji ──────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(
        `SELECT id, city, name, slug, address, sort_order, active, created_at
         FROM locations ORDER BY sort_order, city`
      );
      return res.status(200).json({ rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST nowa lokalizacja ─────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const b = req.body || {};
      if (!b.city || !b.name) return res.status(400).json({ error: 'city i name są wymagane.' });
      const slug = b.slug || b.city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-');
      const { rows: [loc] } = await pool.query(
        `INSERT INTO locations (city, name, slug, address, sort_order, active)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.city, b.name, slug, b.address||null, b.sort_order||99, b.active!==false]
      );
      return res.status(201).json(loc);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
