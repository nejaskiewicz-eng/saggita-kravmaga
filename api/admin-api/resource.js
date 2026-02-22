// api/admin-api/resource.js
// GET/PATCH/DELETE dla groups, schedules, locations
// Usage: /api/admin-api/resource?type=groups&id=5
const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const { type, id } = req.query;

  const CONFIG = {
    groups: {
      table: 'groups',
      allowed: ['location_id','name','category','age_range','max_capacity','notes','active'],
      getQuery: `SELECT g.*, l.city FROM groups g LEFT JOIN locations l ON l.id = g.location_id WHERE g.id = $1`
    },
    schedules: {
      table: 'schedules',
      allowed: ['group_id','day_of_week','day_name','time_start','time_end','time_label','address','active'],
      getQuery: `SELECT s.*, g.name AS group_name FROM schedules s LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = $1`
    },
    locations: {
      table: 'locations',
      allowed: ['city','name','slug','address','sort_order','active'],
      getQuery: `SELECT * FROM locations WHERE id = $1`
    }
  };

  if (!CONFIG[type]) {
    return res.status(400).json({ error: 'Invalid type. Use: groups, schedules, or locations' });
  }

  const { table, allowed, getQuery } = CONFIG[type];

  // ── GET ────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(getQuery, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(rows[0]);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH ──────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    try {
      const b = req.body || {};
      const set = [], vals = [];
      let pi = 1;
      for (const key of allowed) {
        if (key in b) {
          set.push(`${key}=$${pi++}`);
          vals.push(b[key]);
        }
      }
      if (!set.length) return res.status(400).json({ error: 'No fields to update' });
      vals.push(id);
      const { rowCount } = await pool.query(
        `UPDATE ${table} SET ${set.join(',')} WHERE id=$${pi}`,
        vals
      );
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ─────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
