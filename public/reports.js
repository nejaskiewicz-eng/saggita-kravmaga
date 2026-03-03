// api/admin-api/reports.js
// Raporty miesięczne i roczne: dla grupy i dla instruktora
const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const { type, id, year, month } = req.query;
  // type: 'group' | 'instructor'
  // id: group_id or instructor_id
  // year: 2025 (required)
  // month: 1-12 (optional — if absent = full year)

  if (!type || !id || !year) return res.status(400).json({ error: 'type, id, year są wymagane.' });

  const y = parseInt(year);
  const m = month ? parseInt(month) : null;

  try {
    if (type === 'group') {
      // ── RAPORT GRUPY ─────────────────────────────────────────

      // Podstawowe dane grupy
      const { rows:[grp] } = await pool.query(
        `SELECT g.name, g.category, g.age_range, l.city, l.name AS location_name,
          (SELECT COUNT(DISTINCT sg.student_id) FROM student_groups sg WHERE sg.group_id=g.id AND sg.active=true)::int AS active_students
         FROM groups g LEFT JOIN locations l ON l.id=g.location_id WHERE g.id=$1`, [id]);
      if (!grp) return res.status(404).json({ error: 'Nie znaleziono grupy.' });

      // Zakres dat
      const dateFrom = m ? `${y}-${String(m).padStart(2,'0')}-01` : `${y}-01-01`;
      const dateTo   = m
        ? new Date(y, m, 0).toISOString().slice(0,10) // last day of month
        : `${y}-12-31`;

      // Sesje w zakresie
      const { rows: sessions } = await pool.query(`
        SELECT ts.id, ts.session_date::date AS date,
          COUNT(a.id) FILTER (WHERE a.present=true)::int AS present,
          COUNT(a.id)::int AS total
        FROM training_sessions ts
        LEFT JOIN attendances a ON a.session_id = ts.id
        WHERE ts.group_id=$1 AND ts.session_date BETWEEN $2 AND $3
        GROUP BY ts.id ORDER BY ts.session_date
      `, [id, dateFrom, dateTo]);

      // Płatności w zakresie
      const { rows: payments } = await pool.query(`
        SELECT lp.id, lp.amount, lp.paid_at::date AS date, lp.note, lp.created_by,
          s.first_name||' '||s.last_name AS student_name,
          CASE WHEN lp.created_by LIKE 'instructor:%'
            THEN (SELECT i.first_name||' '||i.last_name FROM instructors i WHERE i.id=SUBSTRING(lp.created_by FROM 12)::int)
            ELSE NULL END AS accepted_by
        FROM legacy_payments lp
        JOIN students s ON s.id=lp.student_id
        JOIN student_groups sg ON sg.student_id=s.id AND sg.group_id=$1
        WHERE lp.paid_at BETWEEN $2 AND $3
        ORDER BY lp.paid_at DESC
      `, [id, dateFrom, dateTo]);

      // Frekwencja per kursant w zakresie
      const { rows: attendance } = await pool.query(`
        SELECT s.id, s.first_name||' '||s.last_name AS name,
          COUNT(a.id) FILTER (WHERE a.present=true)::int AS present,
          COUNT(a.id)::int AS total_sessions,
          ROUND(COUNT(a.id) FILTER (WHERE a.present=true)::numeric / NULLIF(COUNT(a.id),0) * 100)::int AS pct
        FROM students s
        JOIN student_groups sg ON sg.student_id=s.id AND sg.group_id=$1 AND sg.active=true
        LEFT JOIN attendances a ON a.student_id=s.id
        LEFT JOIN training_sessions ts ON ts.id=a.session_id AND ts.session_date BETWEEN $2 AND $3
        GROUP BY s.id ORDER BY s.last_name, s.first_name
      `, [id, dateFrom, dateTo]);

      // Instruktorzy grupy
      const { rows: instructors } = await pool.query(`
        SELECT i.id, i.first_name||' '||i.last_name AS name
        FROM instructors i
        JOIN instructor_groups ig ON ig.instructor_id=i.id AND ig.group_id=$1
        WHERE i.active=true
      `, [id]);

      const totalPayments = payments.reduce((s,p)=>s+Number(p.amount),0);

      return res.status(200).json({
        group: grp,
        period: { year: y, month: m, dateFrom, dateTo },
        summary: {
          sessions_count: sessions.length,
          total_payments: totalPayments,
          avg_attendance: sessions.length
            ? Math.round(sessions.reduce((s,x)=>s+(x.total>0?x.present/x.total*100:0),0)/sessions.length)
            : 0
        },
        sessions, payments, attendance, instructors
      });
    }

    if (type === 'instructor') {
      // ── RAPORT INSTRUKTORA ────────────────────────────────────

      const { rows:[inst] } = await pool.query(
        `SELECT id, first_name||' '||last_name AS name, email FROM instructors WHERE id=$1`, [id]);
      if (!inst) return res.status(404).json({ error: 'Nie znaleziono instruktora.' });

      const dateFrom = m ? `${y}-${String(m).padStart(2,'0')}-01` : `${y}-01-01`;
      const dateTo   = m ? new Date(y, m, 0).toISOString().slice(0,10) : `${y}-12-31`;

      // Grupy instruktora
      const { rows: groups } = await pool.query(`
        SELECT g.id, g.name, l.city,
          (SELECT COUNT(DISTINCT sg2.student_id) FROM student_groups sg2 WHERE sg2.group_id=g.id AND sg2.active=true)::int AS students
        FROM instructor_groups ig
        JOIN groups g ON g.id=ig.group_id
        LEFT JOIN locations l ON l.id=g.location_id
        WHERE ig.instructor_id=$1 AND g.active=true
        ORDER BY l.city, g.name
      `, [id]);

      // Sesje prowadzone przez instruktora (przez grupy)
      const { rows: sessions } = await pool.query(`
        SELECT ts.id, ts.session_date::date AS date, g.name AS group_name,
          COUNT(a.id) FILTER (WHERE a.present=true)::int AS present,
          COUNT(a.id)::int AS total
        FROM training_sessions ts
        JOIN groups g ON g.id=ts.group_id
        LEFT JOIN attendances a ON a.session_id=ts.id
        WHERE g.id IN (SELECT group_id FROM instructor_groups WHERE instructor_id=$1)
          AND ts.session_date BETWEEN $2 AND $3
        GROUP BY ts.id, g.name ORDER BY ts.session_date DESC
      `, [id, dateFrom, dateTo]);

      // Płatności przyjęte przez instruktora
      const { rows: payments } = await pool.query(`
        SELECT lp.id, lp.amount, lp.paid_at::date AS date, lp.note,
          s.first_name||' '||s.last_name AS student_name,
          g.name AS group_name
        FROM legacy_payments lp
        JOIN students s ON s.id=lp.student_id
        LEFT JOIN student_groups sg ON sg.student_id=s.id AND sg.active=true
        LEFT JOIN groups g ON g.id=sg.group_id
        WHERE lp.created_by=$1 AND lp.paid_at BETWEEN $2 AND $3
        ORDER BY lp.paid_at DESC
      `, [`instructor:${id}`, dateFrom, dateTo]);

      // Alerty (dodani kursanci, przyjęte płatności)
      const { rows: events } = await pool.query(`
        SELECT ie.event_type, ie.amount, ie.note, ie.created_at, ie.metadata,
          s.first_name||' '||s.last_name AS student_name,
          g.name AS group_name
        FROM instructor_events ie
        LEFT JOIN students s ON s.id=ie.student_id
        LEFT JOIN groups g ON g.id=ie.group_id
        WHERE ie.instructor_id=$1 AND ie.created_at BETWEEN $2 AND $3
        ORDER BY ie.created_at DESC
      `, [id, dateFrom, dateTo]);

      const totalPaid = payments.reduce((s,p)=>s+Number(p.amount),0);

      return res.status(200).json({
        instructor: inst,
        period: { year: y, month: m, dateFrom, dateTo },
        summary: {
          groups_count: groups.length,
          sessions_count: sessions.length,
          payments_accepted: payments.length,
          total_payments: totalPaid,
          students_added: events.filter(e=>e.event_type==='student_added').length
        },
        groups, sessions, payments, events
      });
    }

    return res.status(400).json({ error: 'type musi być: group lub instructor' });
  } catch(e) {
    console.error('[reports]', e);
    return res.status(500).json({ error: e.message });
  }
};
