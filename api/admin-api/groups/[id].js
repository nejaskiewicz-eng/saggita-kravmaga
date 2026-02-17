// api/admin-api/groups/[id].js  — Funkcja #10
// GET    /api/admin-api/groups/:id/members  → lista kursantów grupy
// PATCH  /api/admin-api/groups/:id          → edycja grupy
// DELETE /api/admin-api/groups/:id          → usunięcie grupy
const { getPool } = require('../../_lib/db');
const { requireAuth } = require('../../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const { id } = req.query;
  // Obsługa /groups/:id/members — Vercel przekazuje dodatkowe segmenty
  const pathSegments = (req.url || '').split('/').filter(Boolean);
  const isMembers = pathSegments.includes('members');

  // ── GET members ────────────────────────────────────────────────
  if (req.method === 'GET' && isMembers) {
    try {
      const { rows } = await pool.query(`
        SELECT r.id, r.first_name, r.last_name, r.email, r.phone,
               r.status, r.payment_status, r.is_waitlist, r.created_at
        FROM registrations r
        WHERE r.group_id = $1 AND r.status != 'cancelled'
        ORDER BY r.last_name, r.first_name`, [id]);
      return res.status(200).json({ rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
// ── GET pojedyncza grupa ───────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(`
        SELECT g.*, l.city
        FROM groups g
        LEFT JOIN locations l ON l.id = g.location_id
        WHERE g.id = $1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Nie znaleziono grupy.' });
      return res.status(200).json(rows[0]);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  // ── PATCH edycja grupy ─────────────────────────────────────────
  if (req.method === 'PATCH') {
    try {
      const b = req.body || {};
      const ALLOWED = ['location_id','name','category','age_range','max_capacity','notes','active'];
      const set = [], vals = [];
      let pi = 1;
      for (const key of ALLOWED) {
        if (key in b) { set.push(`${key}=$${pi++}`); vals.push(b[key]); }
      }
      if (!set.length) return res.status(400).json({ error: 'Brak pól.' });
      vals.push(id);
      const { rowCount } = await pool.query(
        `UPDATE groups SET ${set.join(',')} WHERE id=$${pi}`, vals
      );
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ─────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      const { rowCount } = await pool.query(`DELETE FROM groups WHERE id=$1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
