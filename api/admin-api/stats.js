// api/admin-api/stats.js
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

    // 1) Rejestracje (nowy system) — liczniki statusów płatności
    const { rows: [regTotals] } = await pool.query(`
      SELECT
        COUNT(*)::int AS reg_total,
        COUNT(*) FILTER (WHERE is_waitlist=true)::int AS waitlist
      FROM registrations
      WHERE status != 'cancelled'
    `);

    // 2) Ujednolicone statystyki płatności dla wszystkich aktywnych kursantów
    const { rows: [payStats] } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_active,
        COUNT(*) FILTER (
          WHERE (r.payment_status = 'paid')
          OR (s.registration_id IS NULL AND EXISTS(SELECT 1 FROM legacy_payments lp WHERE lp.student_id=s.id AND lp.paid_at >= CURRENT_DATE - INTERVAL '35 days'))
        )::int AS paid,
        COUNT(*) FILTER (
          WHERE (r.payment_status IN ('unpaid','pending') AND r.is_waitlist=false)
          OR (s.registration_id IS NULL AND (
               NOT EXISTS(SELECT 1 FROM legacy_payments lp2 WHERE lp2.student_id=s.id)
               OR (SELECT MAX(lp3.paid_at) FROM legacy_payments lp3 WHERE lp3.student_id=s.id) < CURRENT_DATE - INTERVAL '35 days'
             ))
        )::int AS pending
      FROM students s
      LEFT JOIN registrations r ON r.id = s.registration_id
      WHERE s.is_active = true
    `);

    // 2) Legacy — ilu kursantów jest realnie przypisanych do grup (aktywny wpis w student_groups)
    const { rows: [legacyTotals] } = await pool.query(`
      SELECT
        COUNT(DISTINCT sg.student_id)::int AS legacy_total
      FROM student_groups sg
      JOIN students s ON s.id = sg.student_id
      WHERE sg.active = true AND s.is_active = true
    `);

    // 3) Obłożenie lokalizacji (ujednolicone)
    const { rows: byLoc } = await pool.query(`
      WITH stud_stats AS (
        SELECT
          l.id AS location_id,
          COUNT(s.id) AS total,
          COUNT(s.id) FILTER (
            WHERE (r.payment_status = 'paid')
            OR (s.registration_id IS NULL AND EXISTS(SELECT 1 FROM legacy_payments lp WHERE lp.student_id=s.id AND lp.paid_at >= CURRENT_DATE - INTERVAL '35 days'))
          ) AS paid,
          COUNT(s.id) FILTER (
            WHERE (r.payment_status IN ('unpaid','pending') AND r.is_waitlist=false)
            OR (s.registration_id IS NULL AND (
                 NOT EXISTS(SELECT 1 FROM legacy_payments lp2 WHERE lp2.student_id=s.id)
                 OR (SELECT MAX(lp3.paid_at) FROM legacy_payments lp3 WHERE lp3.student_id=s.id) < CURRENT_DATE - INTERVAL '35 days'
               ))
          ) AS pending,
          COUNT(s.id) FILTER (WHERE r.is_waitlist=true) AS waitlist
        FROM locations l
        LEFT JOIN groups g ON g.location_id = l.id
        LEFT JOIN student_groups sg ON sg.group_id = g.id AND sg.active = true
        LEFT JOIN students s ON s.id = sg.student_id AND s.is_active = true
        LEFT JOIN registrations r ON r.id = s.registration_id
        WHERE l.active = true
        GROUP BY l.id
      )
      SELECT
        l.city,
        COALESCE(ss.total, 0)::int AS total,
        COALESCE(ss.paid, 0)::int AS paid,
        COALESCE(ss.pending, 0)::int AS pending,
        COALESCE(ss.waitlist, 0)::int AS waitlist
      FROM locations l
      LEFT JOIN stud_stats ss ON ss.location_id = l.id
      WHERE l.active = true
      ORDER BY l.city
    `);

    // 4) Obłożenie grup (ujednolicone)
    const { rows: byGroup } = await pool.query(`
      SELECT
        l.city,
        g.name,
        g.max_capacity,
        COUNT(s.id) FILTER (WHERE COALESCE(r.is_waitlist, false) = false)::int AS registered
      FROM groups g
      LEFT JOIN locations l ON l.id = g.location_id
      LEFT JOIN student_groups sg ON sg.group_id = g.id AND sg.active = true
      LEFT JOIN students s ON s.id = sg.student_id AND s.is_active = true
      LEFT JOIN registrations r ON r.id = s.registration_id
      WHERE (g.active = true OR s.id IS NOT NULL)
      GROUP BY l.city, g.name, g.max_capacity, g.active
      ORDER BY l.city, g.name
    `);

    // 5) Ostatnie zapisy — tylko nowe rejestracje (legacy nie ma "created_at zapisu")
    const { rows: recent } = await pool.query(`
      SELECT
        r.id,
        r.first_name || ' ' || r.last_name AS name,
        l.city,
        g.name AS group_name,
        r.status,
        r.payment_status,
        r.created_at
      FROM registrations r
      LEFT JOIN groups g ON g.id = r.group_id
      LEFT JOIN locations l ON l.id = r.location_id
      WHERE r.status != 'cancelled'
      ORDER BY r.created_at DESC
      LIMIT 10
    `);

    return res.status(200).json({
      total: payStats.total_active,
      paid: payStats.paid || 0,
      pending: payStats.pending || 0,
      waitlist: regTotals.waitlist || 0,
      byLoc,
      byGroup,
      recent
    });

  } catch (e) {
    console.error('[admin/stats]', e);
    return res.status(500).json({ error: e.message });
  }
};