// api/admin-api/locations/[id].js
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

  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(`SELECT * FROM locations WHERE id = $1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Nie znaleziono lokalizacji.' });
      return res.status(200).json(rows[0]);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const b = req.body || {};
      const ALLOWED = ['city','name','slug','address','sort_order','active'];
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

  if (req.method === 'DELETE') {
    try {
      const { rowCount } = await pool.query(`DELETE FROM locations WHERE id=$1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};