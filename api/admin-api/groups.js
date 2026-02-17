// api/admin-api/groups.js
// GET  /api/admin-api/groups → lista grup
// POST /api/admin-api/groups → nowa grupa
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

  // ── GET lista grup ─────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(`
        SELECT
          g.*,
          l.city, l.name AS location_name,
          COUNT(r.id) FILTER (WHERE r.is_waitlist=false AND r.status!='cancelled')::int AS registered,
          json_agg(
            json_build_object(
              'id', s.id, 'day_of_week', s.day_of_week, 'day_name', s.day_name,
              'time_start', s.time_start, 'time_end', s.time_end,
              'time_label', s.time_label, 'address', s.address, 'active', s.active
            ) ORDER BY s.day_of_week, s.time_start
          ) FILTER (WHERE s.id IS NOT NULL) AS schedules
        FROM groups g
        LEFT JOIN locations l ON l.id = g.location_id
        LEFT JOIN registrations r ON r.group_id = g.id
        LEFT JOIN schedules s ON s.group_id = g.id
        GROUP BY g.id, l.city, l.name
        ORDER BY l.city, g.name
      `);
      return res.status(200).json({ rows });
    } catch (e) {
      console.error('[groups GET]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST nowa grupa ────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ error: 'Nazwa grupy jest wymagana.' });
      const { rows: [g] } = await pool.query(
        `INSERT INTO groups (location_id, name, category, age_range, max_capacity, notes, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.location_id||null, b.name, b.category||'adults',
         b.age_range||null, b.max_capacity||20, b.notes||null, b.active!==false]
      );
      return res.status(201).json(g);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
