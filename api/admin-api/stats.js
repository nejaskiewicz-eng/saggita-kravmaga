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
        COUNT(*) FILTER (WHERE payment_status='paid')::int AS paid,
        COUNT(*) FILTER (WHERE payment_status IN ('unpaid','pending'))::int AS pending,
        COUNT(*) FILTER (WHERE is_waitlist=true)::int AS waitlist
      FROM registrations
      WHERE status != 'cancelled'
    `);

    // 2) Legacy — ilu kursantów jest realnie przypisanych do grup (aktywny wpis w student_groups)
    const { rows: [legacyTotals] } = await pool.query(`
      SELECT
        COUNT(DISTINCT sg.student_id)::int AS legacy_total
      FROM student_groups sg
      JOIN students s ON s.id = sg.student_id
      WHERE sg.active = true AND s.is_active = true
    `);

    // 3) Obłożenie lokalizacji: registrations + legacy
    const { rows: byLoc } = await pool.query(`
      WITH reg AS (
        SELECT
          l.id AS location_id,
          COUNT(r.id)::int AS total,
          COUNT(r.id) FILTER (WHERE r.payment_status='paid')::int AS paid,
          COUNT(r.id) FILTER (WHERE r.payment_status IN ('unpaid','pending') AND r.is_waitlist=false)::int AS pending,
          COUNT(r.id) FILTER (WHERE r.is_waitlist=true)::int AS waitlist
        FROM locations l
        LEFT JOIN registrations r
          ON r.location_id = l.id
         AND r.status != 'cancelled'
        WHERE l.active = true
        GROUP BY l.id
      ),
      leg AS (
        SELECT
          l.id AS location_id,
          COUNT(DISTINCT sg.student_id)::int AS legacy_students
        FROM locations l
        LEFT JOIN groups g ON g.location_id = l.id
        LEFT JOIN student_groups sg ON sg.group_id = g.id AND sg.active = true
        LEFT JOIN students s ON s.id = sg.student_id AND s.is_active = true
        WHERE l.active = true
        GROUP BY l.id
      )
      SELECT
        l.city,
        (COALESCE(reg.total,0) + COALESCE(leg.legacy_students,0))::int AS total,
        COALESCE(reg.paid,0)::int AS paid,
        COALESCE(reg.pending,0)::int AS pending,
        COALESCE(reg.waitlist,0)::int AS waitlist
      FROM locations l
      LEFT JOIN reg ON reg.location_id = l.id
      LEFT JOIN leg ON leg.location_id = l.id
      WHERE l.active = true
      ORDER BY l.city
    `);

    // 4) Obłożenie grup: registrations + legacy
    // Pokaż grupy aktywne ORAZ te, które mają przypisanych legacy kursantów (żeby Wałbrzych i "kobiety" nie znikały).
    const { rows: byGroup } = await pool.query(`
      WITH reg AS (
        SELECT
          g.id AS group_id,
          COUNT(r.id) FILTER (WHERE r.is_waitlist=false AND r.status != 'cancelled')::int AS reg_count
        FROM groups g
        LEFT JOIN registrations r ON r.group_id = g.id
        GROUP BY g.id
      ),
      leg AS (
        SELECT
          g.id AS group_id,
          COUNT(DISTINCT sg.student_id)::int AS legacy_count
        FROM groups g
        LEFT JOIN student_groups sg ON sg.group_id = g.id AND sg.active = true
        LEFT JOIN students s ON s.id = sg.student_id AND s.is_active = true
        GROUP BY g.id
      )
      SELECT
        l.city,
        g.name,
        g.max_capacity,
        (COALESCE(reg.reg_count,0) + COALESCE(leg.legacy_count,0))::int AS registered
      FROM groups g
      LEFT JOIN locations l ON l.id = g.location_id
      LEFT JOIN reg ON reg.group_id = g.id
      LEFT JOIN leg ON leg.group_id = g.id
      WHERE (g.active = true OR COALESCE(leg.legacy_count,0) > 0 OR COALESCE(reg.reg_count,0) > 0)
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

    const total = (regTotals.reg_total || 0) + (legacyTotals.legacy_total || 0);

    return res.status(200).json({
      total,
      paid: regTotals.paid || 0,
      pending: regTotals.pending || 0,
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