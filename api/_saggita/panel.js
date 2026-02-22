// api/instructor/panel.js  — FUNKCJA #11
// Routing przez ?_route=:
//   groups   → GET /api/instructor/groups
//   students → GET /api/instructor/groups/:id/students
//   stats    → GET /api/instructor/groups/:id/stats
//   payments → GET /api/instructor/payments

const { getPool } = require('../_lib/db');
const { getInstructor } = require('./auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let instructor;
  try { instructor = getInstructor(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const { _route: route, id } = req.query;
  const instructorId = instructor.sub;

  // ── GRUPY instruktora ─────────────────────────────────────────
  if (route === 'groups') {
    try {
      const { rows } = await pool.query(`
        SELECT
          g.id, g.name, g.category, g.age_range, g.max_capacity, g.notes,
          l.city, l.name AS location_name, l.address,
          COUNT(DISTINCT sg.student_id) FILTER (WHERE sg.active = true)::int AS student_count,
          COUNT(DISTINCT r.id) FILTER (WHERE r.status != 'cancelled' AND r.is_waitlist = false)::int AS registered,
          COALESCE(json_agg(
            json_build_object(
              'id', s.id, 'day_name', s.day_name,
              'time_start', s.time_start, 'time_end', s.time_end,
              'address', s.address
            ) ORDER BY s.day_of_week
          ) FILTER (WHERE s.id IS NOT NULL), '[]') AS schedules,
          (SELECT MAX(ts.session_date)
           FROM training_sessions ts
           WHERE ts.group_id = g.id) AS last_session
        FROM instructor_groups ig
        JOIN groups g ON g.id = ig.group_id
        LEFT JOIN locations l ON l.id = g.location_id
        LEFT JOIN student_groups sg ON sg.group_id = g.id
        LEFT JOIN registrations r ON r.group_id = g.id
        LEFT JOIN schedules s ON s.group_id = g.id AND s.active = true
        WHERE ig.instructor_id = $1 AND g.active = true
        GROUP BY g.id, l.city, l.name, l.address
        ORDER BY l.city, g.name
      `, [instructorId]);

      return res.status(200).json({ rows });
    } catch (e) {
      console.error('[instructor/groups]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── KURSANCI grupy ────────────────────────────────────────────
  if (route === 'students' && id) {
    try {
      // Sprawdź że instruktor ma dostęp do tej grupy
      const { rows: [access] } = await pool.query(
        `SELECT 1 FROM instructor_groups WHERE instructor_id = $1 AND group_id = $2`,
        [instructorId, parseInt(id)]
      );
      if (!access) return res.status(403).json({ error: 'Brak dostępu do tej grupy.' });

      // Kursanci legacy (z tabeli students)
      const { rows: legacyStudents } = await pool.query(`
        SELECT
          s.id, s.legacy_id, s.first_name, s.last_name, s.email, s.phone,
          s.is_active, 'legacy' AS source,
          COUNT(a.id) FILTER (WHERE a.present = true)::int AS total_present,
          COUNT(a.id)::int AS total_sessions,
          ROUND(
            COUNT(a.id) FILTER (WHERE a.present = true)::numeric /
            NULLIF(COUNT(a.id), 0) * 100, 0
          )::int AS attendance_pct,
          MAX(ts.session_date) AS last_training,
          -- Status płatności (legacy: ostatnia płatność)
          (SELECT lp.paid_at FROM legacy_payments lp WHERE lp.student_id = s.id ORDER BY lp.paid_at DESC NULLS LAST LIMIT 1) AS last_payment_date
        FROM student_groups sg
        JOIN students s ON s.id = sg.student_id
        LEFT JOIN attendances a ON a.student_id = s.id
        LEFT JOIN training_sessions ts ON ts.id = a.session_id AND ts.group_id = $1::int
        WHERE sg.group_id = $1::int AND sg.active = true
        GROUP BY s.id
        ORDER BY s.last_name, s.first_name
      `, [parseInt(id)]);

      // Kursanci z nowych rejestracji
      const { rows: newStudents } = await pool.query(`
        SELECT
          r.id AS registration_id, NULL AS legacy_id,
          r.first_name, r.last_name, r.email, r.phone,
          true AS is_active, 'registration' AS source,
          r.payment_status,
          r.total_amount,
          pp.name AS plan_name,
          r.is_new,
          r.created_at AS registered_at
        FROM registrations r
        LEFT JOIN price_plans pp ON pp.id = r.price_plan_id
        WHERE r.group_id = $1 AND r.status != 'cancelled' AND r.is_waitlist = false
        ORDER BY r.last_name, r.first_name
      `, [parseInt(id)]);

      return res.status(200).json({
        legacy: legacyStudents,
        registered: newStudents,
        total: legacyStudents.length + newStudents.length,
      });
    } catch (e) {
      console.error('[instructor/students]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── STATYSTYKI grupy ──────────────────────────────────────────
  if (route === 'stats' && id) {
    try {
      const { rows: [access] } = await pool.query(
        `SELECT 1 FROM instructor_groups WHERE instructor_id = $1 AND group_id = $2`,
        [instructorId, parseInt(id)]
      );
      if (!access) return res.status(403).json({ error: 'Brak dostępu do tej grupy.' });

      // Ostatnie 20 sesji z frekwencją
      const { rows: sessions } = await pool.query(`
        SELECT
          ts.id, ts.session_date,
          COUNT(a.id)::int AS total_students,
          COUNT(a.id) FILTER (WHERE a.present = true)::int AS present_count,
          ROUND(
            COUNT(a.id) FILTER (WHERE a.present = true)::numeric /
            NULLIF(COUNT(a.id), 0) * 100, 0
          )::int AS attendance_pct
        FROM training_sessions ts
        LEFT JOIN attendances a ON a.session_id = ts.id
        WHERE ts.group_id = $1
        GROUP BY ts.id
        ORDER BY ts.session_date DESC
        LIMIT 20
      `, [parseInt(id)]);

      // Top 10 kursantów wg frekwencji
      const { rows: topStudents } = await pool.query(`
        SELECT
          s.first_name, s.last_name,
          COUNT(a.id) FILTER (WHERE a.present = true)::int AS present,
          COUNT(a.id)::int AS total,
          ROUND(COUNT(a.id) FILTER (WHERE a.present = true)::numeric / NULLIF(COUNT(a.id),0) * 100, 0)::int AS pct
        FROM student_groups sg
        JOIN students s ON s.id = sg.student_id
        LEFT JOIN attendances a ON a.student_id = s.id
        LEFT JOIN training_sessions ts ON ts.id = a.session_id AND ts.group_id = $1
        WHERE sg.group_id = $1 AND sg.active = true
        GROUP BY s.id
        HAVING COUNT(a.id) > 0
        ORDER BY pct DESC, present DESC
        LIMIT 10
      `, [parseInt(id)]);

      // Ogólne statystyki grupy
      const { rows: [summary] } = await pool.query(`
        SELECT
          COUNT(DISTINCT ts.id)::int AS total_sessions,
          ROUND(AVG(
            (SELECT COUNT(*) FROM attendances a2 WHERE a2.session_id = ts.id AND a2.present = true)::numeric /
            NULLIF((SELECT COUNT(*) FROM attendances a3 WHERE a3.session_id = ts.id), 0) * 100
          ), 0)::int AS avg_attendance_pct,
          MIN(ts.session_date) AS first_session,
          MAX(ts.session_date) AS last_session
        FROM training_sessions ts
        WHERE ts.group_id = $1
      `, [parseInt(id)]);

      return res.status(200).json({ sessions, topStudents, summary });
    } catch (e) {
      console.error('[instructor/stats]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PŁATNOŚCI kursantów (status, nie kwoty) ───────────────────
  if (route === 'payments') {
    try {
      const { group_id } = req.query;

      // Sprawdź dostęp
      if (group_id) {
        const { rows: [access] } = await pool.query(
          `SELECT 1 FROM instructor_groups WHERE instructor_id = $1 AND group_id = $2`,
          [instructorId, parseInt(group_id)]
        );
        if (!access) return res.status(403).json({ error: 'Brak dostępu do tej grupy.' });
      }

      // Sprawdź dostępne grupy instruktora
      const { rows: myGroups } = await pool.query(
        `SELECT group_id FROM instructor_groups WHERE instructor_id = $1`,
        [instructorId]
      );
      const groupIds = myGroups.map(g => g.group_id);
      if (!groupIds.length) return res.status(200).json({ rows: [] });

      const targetGroups = group_id ? [parseInt(group_id)] : groupIds;

      // Status płatności nowych rejestracji
      const { rows } = await pool.query(`
        SELECT
          r.id AS registration_id,
          r.first_name, r.last_name,
          r.payment_status,
          r.payment_method,
          r.is_waitlist,
          r.has_membership,
          g.name AS group_name,
          pp.name AS plan_name,
          r.created_at,
          r.start_date,
          -- Kwoty tylko status, nie kwota (prywatność)
          CASE WHEN r.payment_status = 'paid' THEN 'Opłacone'
               WHEN r.payment_status = 'waived' THEN 'Zwolniony'
               WHEN r.payment_status = 'unpaid' THEN 'Nieopłacone'
               ELSE r.payment_status END AS payment_label
        FROM registrations r
        LEFT JOIN groups g ON g.id = r.group_id
        LEFT JOIN price_plans pp ON pp.id = r.price_plan_id
        WHERE r.group_id = ANY($1::int[])
          AND r.status != 'cancelled'
        ORDER BY r.payment_status, r.last_name
      `, [targetGroups]);

      return res.status(200).json({ rows });
    } catch (e) {
      console.error('[instructor/payments]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Nieprawidłowa trasa.' });
};
