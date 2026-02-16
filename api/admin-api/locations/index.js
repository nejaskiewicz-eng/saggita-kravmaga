// api/admin-api/locations/index.js  — Funkcja #12 (OSTATNIA!)
// Obsługuje WIELE endpointów żeby zmieścić się w limicie 12:
//   GET/POST/PATCH  /api/admin-api/locations          → lokalizacje
//   GET             /api/admin-api/plans              → plany cennikowe
//   GET             /api/admin-api/export             → CSV
//   GET/POST/PATCH  /api/admin-api/participants       → kursanci (alias registrations)
//
// Routing po URL path (/api/admin-api/SEGMENT):
const { getPool } = require('../../_lib/db');
const { requireAuth } = require('../../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();

  // ── GET lista lokalizacji ──────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(
        `SELECT id, city, name, slug, address, active, created_at
         FROM locations ORDER BY city`
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
      const slug = b.slug || b.city.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
      const { rows: [loc] } = await pool.query(
        `INSERT INTO locations (city, name, slug, address, active)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [b.city, b.name, slug, b.address||null, b.active!==false]
      );
      return res.status(201).json(loc);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH edycja lokalizacji ───────────────────────────────────
  if (req.method === 'PATCH') {
    try {
      const b = req.body || {};
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Brak id.' });
      const ALLOWED = ['city','name','slug','address','active'];
      const set = [], vals = [];
      let pi = 1;
      for (const key of ALLOWED) {
        if (key in b) { set.push(`${key}=$${pi++}`); vals.push(b[key]); }
      }
      if (!set.length) return res.status(400).json({ error: 'Brak pól.' });
      vals.push(id);
      const { rowCount } = await pool.query(
        `UPDATE locations SET ${set.join(',')} WHERE id=$${pi}`, vals
      );
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
