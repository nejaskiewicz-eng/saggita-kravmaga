// api/_saggita/students.js
// Ujednolicona baza kursantów: legacy (students) + nowe zapisy (registrations)
// Naprawa: poprawne liczenie WPŁAT i OSTATNIEGO TRENINGU (bez "rozmnażania" przez JOIN-y)
// + metryki sezonu od 2025-09-01

const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

const SEASON_START = '2025-09-01';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const {
    id, pid, aid, _route,
    search, source, group_id, city,
    payment_status, is_active,
    page = 1, limit = 60,
    sort = 'recent',
    overdue, season_only
  } = req.query;

  // ── SUB-ROUTE: płatności ──────────────────────────────────────
  if (id && _route === 'payments') {
    if (req.method === 'GET') {
      const { rows: legacy } = await pool.query(
        `SELECT id,'legacy' AS type,amount,paid_at AS date,note
         FROM legacy_payments
         WHERE student_id=$1
         ORDER BY paid_at DESC NULLS LAST, id DESC`,
        [id]
      ).catch(() => ({ rows: [] }));

      const { rows: regs } = await pool.query(
        `SELECT r.id,'registration' AS type,r.total_amount AS amount,r.created_at AS date,
                r.admin_notes AS note,r.payment_ref,r.payment_status AS status,
                pp.name AS plan_name
         FROM students s
         JOIN registrations r ON r.id=s.registration_id
         LEFT JOIN price_plans pp ON pp.id=r.price_plan_id
         WHERE s.id=$1 AND s.registration_id IS NOT NULL`,
        [id]
      ).catch(() => ({ rows: [] }));

      return res.status(200).json({ legacy, registrations: regs });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.amount) return res.status(400).json({ error: 'Kwota jest wymagana.' });
      try {
        const { rows: [p] } = await pool.query(
          `INSERT INTO legacy_payments (student_id,amount,paid_at,note)
           VALUES ($1,$2,$3,$4)
           RETURNING *`,
          [id, parseFloat(b.amount), b.date || new Date().toISOString().slice(0, 10), b.note || null]
        );
        return res.status(201).json(p);
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'PATCH' && pid) {
      const b = req.body || {};
      const set = [], vals = []; let pi2 = 1;
      for (const k of ['amount', 'paid_at', 'note']) {
        if (k in b) { set.push(`${k}=$${pi2++}`); vals.push(b[k]); }
      }
      if (!set.length) return res.status(400).json({ error: 'Brak pól.' });
      vals.push(pid, id);
      try {
        await pool.query(
          `UPDATE legacy_payments SET ${set.join(',')}
           WHERE id=$${pi2} AND student_id=$${pi2 + 1}`,
          vals
        );
        return res.status(200).json({ success: true });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'DELETE' && pid) {
      try {
        await pool.query(`DELETE FROM legacy_payments WHERE id=$1 AND student_id=$2`, [pid, id]);
        return res.status(200).json({ success: true });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── SUB-ROUTE: obecności ──────────────────────────────────────
  if (id && _route === 'attendance') {
    if (req.method === 'GET') {
      try {
        const { rows } = await pool.query(
          `SELECT a.id,a.present,a.diff_group,
                  ts.session_date,ts.id AS session_id,
                  g.name AS group_name
           FROM attendances a
           JOIN training_sessions ts ON ts.id=a.session_id
           LEFT JOIN groups g ON g.id=ts.group_id
           WHERE a.student_id=$1
           ORDER BY ts.session_date DESC
           LIMIT 200`,
          [id]
        );
        return res.status(200).json({ rows });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'PATCH' && aid) {
      const { present } = req.body || {};
      try {
        await pool.query(`UPDATE attendances SET present=$1 WHERE id=$2`, [!!present, aid]);
        return res.status(200).json({ success: true });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }
  }

  // ── SUB-ROUTE: status płatności rejestracji ───────────────────
  if (id && _route === 'reg-payment') {
    if (req.method === 'PATCH') {
      const { registration_id, payment_status: ps } = req.body || {};
      if (!registration_id || !ps) return res.status(400).json({ error: 'Brak danych.' });
      try {
        await pool.query(`UPDATE registrations SET payment_status=$1,updated_at=NOW() WHERE id=$2`, [ps, registration_id]);
        return res.status(200).json({ success: true });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }
  }

  // ── GET szczegóły kursanta ────────────────────────────────────
  if (req.method === 'GET' && id) {
    try {
      const { rows: [student] } = await pool.query(
        `
        SELECT
          s.*,

          -- grupy
          COALESCE((
            SELECT json_agg(jsonb_build_object('id', g.id, 'name', g.name, 'active', sg.active) ORDER BY g.name)
            FROM student_groups sg
            JOIN groups g ON g.id=sg.group_id
            WHERE sg.student_id=s.id
          ), '[]'::json) AS groups,

          -- metryki sezonu (od 2025-09-01)
          COALESCE((
            SELECT COUNT(*)::int
            FROM attendances a
            JOIN training_sessions ts ON ts.id=a.session_id
            WHERE a.student_id=s.id
              AND ts.session_date >= $2::date
          ), 0) AS total_sessions_season,

          COALESCE((
            SELECT COUNT(*)::int
            FROM attendances a
            JOIN training_sessions ts ON ts.id=a.session_id
            WHERE a.student_id=s.id
              AND a.present=true
              AND ts.session_date >= $2::date
          ), 0) AS total_present,

          (
            SELECT MAX(ts.session_date)
            FROM attendances a
            JOIN training_sessions ts ON ts.id=a.session_id
            WHERE a.student_id=s.id
              AND ts.session_date >= $2::date
          ) AS last_training,

          -- % obecności sezon
          (
            SELECT
              CASE
                WHEN COUNT(*) FILTER (WHERE ts.session_date >= $2::date) = 0 THEN 0
                ELSE ROUND(
                  (COUNT(*) FILTER (WHERE a.present=true AND ts.session_date >= $2::date))::numeric
                  / NULLIF((COUNT(*) FILTER (WHERE ts.session_date >= $2::date))::numeric, 0)
                  * 100, 0
                )::int
              END
            FROM attendances a
            JOIN training_sessions ts ON ts.id=a.session_id
            WHERE a.student_id=s.id
          ) AS attendance_pct_season,

          -- ostatnia płatność legacy (data + kwota z tego samego rekordu)
          (SELECT lp.paid_at FROM legacy_payments lp WHERE lp.student_id=s.id ORDER BY lp.paid_at DESC NULLS LAST, lp.id DESC LIMIT 1) AS last_payment_date,
          (SELECT lp.amount  FROM legacy_payments lp WHERE lp.student_id=s.id ORDER BY lp.paid_at DESC NULLS LAST, lp.id DESC LIMIT 1) AS last_payment_amount,

          -- suma legacy (informacyjnie)
          COALESCE((SELECT SUM(lp.amount)::numeric FROM legacy_payments lp WHERE lp.student_id=s.id), 0)::numeric AS total_legacy_paid

        FROM students s
        WHERE s.id=$1
        `,
        [id, SEASON_START]
      );

      if (!student) return res.status(404).json({ error: 'Nie znaleziono.' });

      let registration = null;
      if (student.registration_id) {
        const { rows: [r] } = await pool.query(
          `SELECT r.*,
                  g.name AS group_name,
                  l.city,
                  pp.name AS plan_name
           FROM registrations r
           LEFT JOIN groups g ON g.id=r.group_id
           LEFT JOIN locations l ON l.id=r.location_id
           LEFT JOIN price_plans pp ON pp.id=r.price_plan_id
           WHERE r.id=$1`,
          [student.registration_id]
        );
        registration = r;
      }

      return res.status(200).json({ ...student, registration });
    } catch (e) {
      console.error('[students GET id]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET lista (ujednolicona, z filtrami) ──────────────────────
  if (req.method === 'GET') {
    try {
      const conds = [];
      const vals = [];
      let pi = 1;

      if (search) {
        conds.push(`(
          s.first_name ILIKE $${pi}
          OR s.last_name ILIKE $${pi}
          OR s.email ILIKE $${pi}
          OR s.phone ILIKE $${pi}
        )`);
        vals.push(`%${search}%`);
        pi++;
      }

      if (source && source !== 'all') { conds.push(`s.source=$${pi++}`); vals.push(source); }
      if (is_active !== undefined && is_active !== '') { conds.push(`s.is_active=$${pi++}`); vals.push(is_active === 'true'); }

      if (group_id) {
        conds.push(`EXISTS(
          SELECT 1 FROM student_groups sg2
          WHERE sg2.student_id=s.id AND sg2.group_id=$${pi++}
        )`);
        vals.push(parseInt(group_id));
      }

      if (city) {
        conds.push(`EXISTS(
          SELECT 1
          FROM student_groups sg3
          JOIN groups g3 ON g3.id=sg3.group_id
          JOIN locations l3 ON l3.id=g3.location_id
          WHERE sg3.student_id=s.id AND l3.city ILIKE $${pi++}
        )`);
        vals.push(`%${city}%`);
      }

      if (payment_status && payment_status !== 'all') {
        conds.push(`EXISTS(
          SELECT 1 FROM registrations r2
          WHERE r2.id=s.registration_id AND r2.payment_status=$${pi++}
        )`);
        vals.push(payment_status);
      }

      // Zaległości
      if (overdue === 'true') {
        conds.push(`s.is_active=true`);
        conds.push(`EXISTS(
          SELECT 1
          FROM attendances a2
          JOIN training_sessions ts2 ON ts2.id=a2.session_id
          WHERE a2.student_id=s.id
            AND a2.present=true
            AND ts2.session_date >= CURRENT_DATE - INTERVAL '60 days'
        )`);
        conds.push(`(
          (s.registration_id IS NULL AND (
            (SELECT MAX(lp2.paid_at) FROM legacy_payments lp2 WHERE lp2.student_id=s.id) < CURRENT_DATE - INTERVAL '35 days'
            OR NOT EXISTS(SELECT 1 FROM legacy_payments lp3 WHERE lp3.student_id=s.id)
          ))
          OR (s.registration_id IS NOT NULL AND EXISTS(
            SELECT 1 FROM registrations r3 WHERE r3.id=s.registration_id AND r3.payment_status NOT IN ('paid')
          ))
        )`);
      }

      // Filtr aktywnego sezonu — tylko kursanci z aktywnością od 2025-09-01
      if (season_only === 'true') {
        conds.push(`(
          EXISTS(
            SELECT 1 FROM attendances a3
            JOIN training_sessions ts3 ON ts3.id=a3.session_id
            WHERE a3.student_id=s.id AND ts3.session_date >= '${SEASON_START}'
          )
          OR EXISTS(
            SELECT 1 FROM legacy_payments lp4
            WHERE lp4.student_id=s.id AND lp4.paid_at >= '${SEASON_START}'
          )
          OR EXISTS(
            SELECT 1 FROM student_groups sg4
            WHERE sg4.student_id=s.id AND sg4.active=true
          )
        )`);
      }

      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const { rows: [{ total }] } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM students s ${where}`,
        vals
      );

      const orderBy =
        sort === 'alpha'
          ? `last_name ASC, first_name ASC`
          : sort === 'payment'
            ? `last_payment_date DESC NULLS LAST, last_name ASC, first_name ASC`
            : `last_training DESC NULLS LAST, last_name ASC, first_name ASC`;

      const { rows } = await pool.query(
        `
        SELECT
          s.id, s.legacy_id, s.first_name, s.last_name, s.email, s.phone, s.birth_year,
          s.is_active, s.source, s.created_at, s.registration_id,

          -- miasto (z aktywnej grupy jeśli jest)
          (
            SELECT l.city
            FROM student_groups sgx
            JOIN groups gx ON gx.id=sgx.group_id
            JOIN locations l ON l.id=gx.location_id
            WHERE sgx.student_id=s.id AND sgx.active=true
            ORDER BY sgx.student_id DESC
            LIMIT 1
          ) AS city,

          -- grupy (aktywnie przypisane)
          COALESCE((
            SELECT json_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
            FROM student_groups sg
            JOIN groups g ON g.id=sg.group_id
            WHERE sg.student_id=s.id AND sg.active=true
          ), '[]'::json) AS groups,

          -- treningi/obecności od 2025-09-01
          COALESCE((
            SELECT COUNT(*)::int
            FROM attendances a
            JOIN training_sessions ts ON ts.id=a.session_id
            WHERE a.student_id=s.id AND ts.session_date >= $${pi}::date
          ), 0) AS total_sessions,

          COALESCE((
            SELECT COUNT(*)::int
            FROM attendances a
            JOIN training_sessions ts ON ts.id=a.session_id
            WHERE a.student_id=s.id AND a.present=true AND ts.session_date >= $${pi}::date
          ), 0) AS total_present,

          COALESCE((
            SELECT COUNT(*)::int
            FROM attendances a
            JOIN training_sessions ts ON ts.id=a.session_id
            WHERE a.student_id=s.id AND a.present=true AND ts.session_date >= CURRENT_DATE - INTERVAL '60 days'
          ), 0) AS present_60d,

          (
            SELECT MAX(ts.session_date)
            FROM attendances a
            JOIN training_sessions ts ON ts.id=a.session_id
            WHERE a.student_id=s.id AND ts.session_date >= $${pi}::date
          ) AS last_training,

          -- ostatnia wpłata legacy (data + kwota z tego samego rekordu)
          (SELECT lp.paid_at FROM legacy_payments lp WHERE lp.student_id=s.id ORDER BY lp.paid_at DESC NULLS LAST, lp.id DESC LIMIT 1) AS last_payment_date,
          (SELECT lp.amount  FROM legacy_payments lp WHERE lp.student_id=s.id ORDER BY lp.paid_at DESC NULLS LAST, lp.id DESC LIMIT 1) AS last_payment_amount,
          (SELECT lp.amount  FROM legacy_payments lp WHERE lp.student_id=s.id ORDER BY lp.paid_at DESC NULLS LAST, lp.id DESC LIMIT 1) AS legacy_paid,
          EXTRACT(DAY FROM (CURRENT_TIMESTAMP - (SELECT lp2.paid_at FROM legacy_payments lp2 WHERE lp2.student_id=s.id ORDER BY lp2.paid_at DESC NULLS LAST, lp2.id DESC LIMIT 1)))::int AS days_since_payment,

          -- rejestracja (jeśli kursant z www)
          r.payment_status,
          r.total_amount,
          pp.name AS plan_name

        FROM students s
        LEFT JOIN registrations r ON r.id=s.registration_id
        LEFT JOIN price_plans pp ON pp.id=r.price_plan_id
        ${where}
        ORDER BY ${orderBy}
        LIMIT $${pi + 1} OFFSET $${pi + 2}
        `,
        [...vals, SEASON_START, parseInt(limit), offset]
      );

      return res.status(200).json({
        rows,
        total,
        page: parseInt(page),
        limit: parseInt(limit)
      });
    } catch (e) {
      console.error('[students GET list]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST nowy kursant ─────────────────────────────────────────
  if (req.method === 'POST') {
    const b = req.body || {};
    if (!b.first_name || !b.last_name) return res.status(400).json({ error: 'Imię i nazwisko są wymagane.' });
    try {
      const { rows: [s] } = await pool.query(
        `INSERT INTO students (first_name,last_name,email,phone,birth_year,is_active,source)
         VALUES ($1,$2,$3,$4,$5,$6,'manual')
         RETURNING *`,
        [b.first_name.trim(), b.last_name.trim(), b.email || null, b.phone || null, b.birth_year || null, b.is_active !== false]
      );
      if (b.group_id) {
        await pool.query(
          `INSERT INTO student_groups (student_id,group_id)
           VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [s.id, b.group_id]
        );
      }
      return res.status(201).json(s);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── PATCH edytuj kursanta ─────────────────────────────────────
  if (req.method === 'PATCH' && id) {
    const b = req.body || {};
    const set = [], vals = [];
    let pi3 = 1;
    for (const k of ['first_name', 'last_name', 'email', 'phone', 'birth_year', 'is_active']) {
      if (k in b) { set.push(`${k}=$${pi3++}`); vals.push(b[k]); }
    }
    if (!set.length) return res.status(400).json({ error: 'Brak pól.' });
    vals.push(id);
    try {
      await pool.query(`UPDATE students SET ${set.join(',')} WHERE id=$${pi3}`, vals);
      return res.status(200).json({ success: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── DELETE usuń / dezaktywuj ──────────────────────────────────
  if (req.method === 'DELETE' && id) {
    try {
      const { rows: [x] } = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM attendances WHERE student_id=$1)::int AS att,
           (SELECT COUNT(*) FROM legacy_payments WHERE student_id=$1)::int AS pay`,
        [id]
      );
      if ((x?.att || 0) > 0 || (x?.pay || 0) > 0) {
        await pool.query(`UPDATE students SET is_active=false WHERE id=$1`, [id]);
        return res.status(200).json({ success: true, soft: true, message: 'Dezaktywowano (kursant ma historię)' });
      }
      await pool.query(`DELETE FROM student_groups WHERE student_id=$1`, [id]);
      await pool.query(`DELETE FROM students WHERE id=$1`, [id]);
      return res.status(200).json({ success: true, soft: false });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};