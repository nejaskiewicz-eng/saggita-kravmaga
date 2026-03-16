// api/admin-api/sessions.js
// Zarządzanie sesjami treningowymi przez admina
const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    requireAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized: ' + e.message });
  }

  const pool = getPool();
  const { group_id, from, to, id } = req.query;

  // GET /api/admin-api/sessions?group_id=X&from=Y&to=Z
  if (req.method === 'GET') {
    if (!group_id) return res.status(400).json({ error: 'group_id jest wymagane.' });
    try {
      const params = [group_id];
      let q = `
        SELECT ts.id AS session_id,
          TO_CHAR(ts.session_date, 'YYYY-MM-DD') AS session_date,
          ts.group_id,
          COUNT(a.id) FILTER (WHERE a.present=true)::int AS present_count,
          COUNT(a.id)::int AS total_marked
        FROM training_sessions ts
        LEFT JOIN attendances a ON a.session_id=ts.id
        WHERE ts.group_id=$1`;
      if (from) { params.push(from); q += ` AND ts.session_date>=$${params.length}`; }
      if (to)   { params.push(to);   q += ` AND ts.session_date<=$${params.length}`; }
      q += ` GROUP BY ts.id ORDER BY ts.session_date`;
      const { rows } = await pool.query(q, params);
      return res.status(200).json({ rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // POST /api/admin-api/sessions  body: { group_id, session_date }
  if (req.method === 'POST') {
    const { group_id: gid, session_date } = req.body || {};
    if (!gid || !session_date) return res.status(400).json({ error: 'group_id i session_date są wymagane.' });
    try {
      const { rows: [x] } = await pool.query(
        `INSERT INTO training_sessions (group_id, session_date)
         VALUES ($1,$2)
         ON CONFLICT (group_id, session_date) DO UPDATE SET session_date=EXCLUDED.session_date
         RETURNING id`,
        [gid, session_date]);
      return res.status(200).json({ id: x.id });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // DELETE /api/admin-api/sessions?id=X
  if (req.method === 'DELETE' && id) {
    try {
      await pool.query(`DELETE FROM attendances WHERE session_id=$1`, [id]);
      await pool.query(`DELETE FROM training_sessions WHERE id=$1`, [id]);
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
