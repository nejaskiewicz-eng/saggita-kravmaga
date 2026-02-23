// api/admin-api/stats.js  — Funkcja #7
// GET /api/admin-api/stats → statystyki dla dashboardu
const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    requireAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized: ' + e.message });
  }

  try {
    const pool = getPool();

    // Ogólne liczniki — nowe zapisy (registrations)
    const { rows: [totals] } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE payment_status='paid')::int AS paid,
        COUNT(*) FILTER (WHERE payment_status IN ('unpaid','pending'))::int AS pending,
        COUNT(*) FILTER (WHERE is_waitlist=true)::int AS waitlist
      FROM registrations
      WHERE status != 'cancelled'
    `);

    // Według lokalizacji — legacy (aktywni kursanci w grupach) + rejestracje
    const { rows: byLoc } = await pool.query(`
      SELECT
        l.city,
        (
          COUNT(DISTINCT r.id) FILTER (WHERE r.status != 'cancelled')
          + COUNT(DISTINCT s.id) FILTER (WHERE s.is_active = true AND s.registration_id IS NULL)
        )::int AS total,
        (
          COUNT(DISTINCT r.id) FILTER (WHERE r.payment_status='paid' AND r.status != 'cancelled')
        )::int AS paid,
        (
          COUNT(DISTINCT r.id) FILTER (WHERE r.payment_status IN ('unpaid','pending') AND r.is_waitlist=false AND r.status != 'cancelled')
        )::int AS pending,
        (
          COUNT(DISTINCT r.id) FILTER (WHERE r.is_waitlist=true AND r.status != 'cancelled')
        )::int AS waitlist
      FROM locations l
      LEFT JOIN registrations r ON r.location_id = l.id
      LEFT JOIN groups g2 ON g2.location_id = l.id AND g2.active = true
      LEFT JOIN student_groups sg ON sg.group_id = g2.id AND sg.active = true
      LEFT JOIN students s ON s.id = sg.student_id
      WHERE l.active = true
      GROUP BY l.city ORDER BY l.city
    `);

    // Obłożenie grup — legacy + rejestracje
    const { rows: byGroup } = await pool.query(`
      SELECT
        l.city, g.name, g.max_capacity,
        (
          COUNT(DISTINCT r.id) FILTER (WHERE r.is_waitlist=false AND r.status != 'cancelled')
          + COUNT(DISTINCT s.id) FILTER (WHERE s.is_active = true AND s.registration_id IS NULL)
        )::int AS registered
      FROM groups g
      LEFT JOIN locations l ON l.id = g.location_id
      LEFT JOIN registrations r ON r.group_id = g.id
      LEFT JOIN student_groups sg ON sg.group_id = g.id AND sg.active = true
      LEFT JOIN students s ON s.id = sg.student_id
      WHERE g.active = true
      GROUP BY l.city, g.name, g.max_capacity ORDER BY l.city, g.name
    `);

    // Ostatnie zapisy
    const { rows: recent } = await pool.query(`
      SELECT
        r.id,
        r.first_name || ' ' || r.last_name AS name,
        l.city, g.name AS group_name,
        r.status, r.payment_status, r.created_at
      FROM registrations r
      LEFT JOIN groups g ON g.id = r.group_id
      LEFT JOIN locations l ON l.id = r.location_id
      ORDER BY r.created_at DESC LIMIT 10
    `);

    return res.status(200).json({ ...totals, byLoc, byGroup, recent });

  } catch (e) {
    console.error('[admin/stats]', e);
    return res.status(500).json({ error: e.message });
  }
};
