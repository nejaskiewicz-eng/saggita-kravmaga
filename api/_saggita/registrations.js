// api/admin-api/registrations.js  — FUNKCJA #8
// Obsługuje 2 trasy w 1 pliku (oszczędność limitu Vercel):
//   GET/PATCH /api/admin-api/registrations         → nowe zapisy
//   GET/PATCH /api/admin-api/registrations?id=X    → konkretny zapis
//   GET       /api/admin-api/history               → historia legacy (students + payments)

const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const route = req.query._route;

  // ══════════════════════════════════════════════════════════════
  // TRASA: /api/admin-api/history  →  historia z legacy systemu
  // ══════════════════════════════════════════════════════════════
  if (route === 'history') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    
    try {
      const { search, group_id, page = 1, limit = 50, tab = 'students' } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      if (tab === 'students') {
        // Lista kursantów legacy + info o ich treningach i płatnościach
        let where = [`s.source = 'legacy'`];
        const vals = [];
        let pi = 1;

        if (search) {
          where.push(`(s.first_name ILIKE $${pi} OR s.last_name ILIKE $${pi} OR s.email ILIKE $${pi})`);
          vals.push(`%${search}%`);
          pi++;
        }
        if (group_id) {
          where.push(`EXISTS(SELECT 1 FROM student_groups sg5 WHERE sg5.student_id=s.id AND sg5.group_id=$${pi})`);
          vals.push(parseInt(group_id));
          pi++;
        }

        const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const whereForCount = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const countVals = [...vals];
        const { rows: [{ total }] } = await pool.query(
          `SELECT COUNT(DISTINCT s.id)::int AS total FROM students s
           ${whereForCount}`, countVals
        );

        // UWAGA: używamy CTE żeby uniknąć iloczynu kartezjańskiego
        // (wielokrotne JOINy powodowały eksplozję wierszy - np. 685345 grup dla jednego kursanta)
        const { rows } = await pool.query(`
          WITH grp_agg AS (
            SELECT sg.student_id,
              COALESCE(json_agg(jsonb_build_object('group_id', sg.group_id, 'group_name', g.name))
                FILTER (WHERE sg.group_id IS NOT NULL), '[]') AS groups
            FROM (SELECT DISTINCT student_id, group_id FROM student_groups) sg
            LEFT JOIN groups g ON g.id = sg.group_id
            GROUP BY sg.student_id
          ),
          att_agg AS (
            SELECT a.student_id,
              COUNT(a.id) FILTER (WHERE a.present = true)::int AS total_attendances,
              MAX(ts.session_date) AS last_training
            FROM attendances a
            JOIN training_sessions ts ON ts.id = a.session_id
            GROUP BY a.student_id
          ),
          pay_agg AS (
            SELECT lp.student_id,
              COALESCE(SUM(lp.amount), 0)::numeric AS total_paid,
              MAX(lp.paid_at) AS last_payment,
              COUNT(lp.id)::int AS payment_count
            FROM legacy_payments lp
            GROUP BY lp.student_id
          )
          SELECT
            s.id, s.legacy_id, s.first_name, s.last_name, s.email, s.phone,
            s.birth_year, s.is_active, s.created_at,
            COALESCE(ga.groups, '[]') AS groups,
            COALESCE(aa.total_attendances, 0) AS total_attendances,
            aa.last_training,
            COALESCE(pa.total_paid, 0) AS total_paid,
            pa.last_payment,
            COALESCE(pa.payment_count, 0) AS payment_count
          FROM students s
          LEFT JOIN grp_agg ga ON ga.student_id = s.id
          LEFT JOIN att_agg aa ON aa.student_id = s.id
          LEFT JOIN pay_agg pa ON pa.student_id = s.id
          ${whereStr}
          GROUP BY s.id, aa.total_attendances, aa.last_training,
                   pa.total_paid, pa.last_payment, pa.payment_count
          ORDER BY s.last_name, s.first_name
          LIMIT $${pi} OFFSET $${pi + 1}
        `, [...vals, parseInt(limit), offset]);

        return res.status(200).json({ rows, total, page: parseInt(page), limit: parseInt(limit) });
      }

      if (tab === 'payments') {
        // Historia płatności legacy
        const { rows } = await pool.query(`
          SELECT
            lp.id, lp.legacy_id, lp.amount, lp.paid_at, lp.note,
            s.first_name, s.last_name, s.email,
            COALESCE(json_agg(
              json_build_object('name', g.name)
            ) FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
          FROM legacy_payments lp
          LEFT JOIN students s ON s.id = lp.student_id
          LEFT JOIN student_groups sg ON sg.student_id = s.id
          LEFT JOIN groups g ON g.id = sg.group_id
          GROUP BY lp.id, s.id
          ORDER BY lp.paid_at DESC NULLS LAST
          LIMIT $1 OFFSET $2
        `, [parseInt(limit), offset]);

        const { rows: [{ total }] } = await pool.query(
          'SELECT COUNT(*)::int AS total FROM legacy_payments'
        );

        return res.status(200).json({ rows, total, page: parseInt(page), limit: parseInt(limit) });
      }

      if (tab === 'attendance') {
        // Historia obecności po grupach / kursantach
        const { student_id } = req.query;
        let where2 = [];
        const vals2 = [];
        let pi2 = 1;

        if (student_id) {
          where2.push(`a.student_id = $${pi2++}`);
          vals2.push(parseInt(student_id));
        }
        if (group_id) {
          where2.push(`ts.group_id = $${pi2++}`);
          vals2.push(parseInt(group_id));
        }
        const w2 = where2.length ? 'WHERE ' + where2.join(' AND ') : '';

        const { rows } = await pool.query(`
          SELECT
            ts.session_date, ts.id AS session_id,
            g.name AS group_name,
            s.first_name, s.last_name,
            a.present, a.diff_group
          FROM attendances a
          JOIN training_sessions ts ON ts.id = a.session_id
          JOIN students s ON s.id = a.student_id
          LEFT JOIN groups g ON g.id = ts.group_id
          ${w2}
          ORDER BY ts.session_date DESC, s.last_name
          LIMIT $${pi2} OFFSET $${pi2 + 1}
        `, [...vals2, parseInt(limit), offset]);

        return res.status(200).json({ rows, page: parseInt(page), limit: parseInt(limit) });
      }

      if (tab === 'stats') {
        // Statystyki historyczne
        const { rows: [summary] } = await pool.query(`
          SELECT
            (SELECT COUNT(*) FROM students WHERE source='legacy')::int AS legacy_students,
            (SELECT COUNT(*) FROM training_sessions)::int AS total_sessions,
            (SELECT COUNT(*) FROM attendances WHERE present=true)::int AS total_present,
            (SELECT COUNT(*) FROM legacy_payments)::int AS total_payments,
            (SELECT COALESCE(SUM(amount),0) FROM legacy_payments)::numeric AS total_revenue
        `);

        const { rows: byYear } = await pool.query(`
          SELECT
            EXTRACT(YEAR FROM paid_at)::int AS year,
            COUNT(*)::int AS payments,
            SUM(amount)::numeric AS revenue
          FROM legacy_payments
          WHERE paid_at IS NOT NULL
          GROUP BY year ORDER BY year DESC
        `);

        const { rows: topStudents } = await pool.query(`
          SELECT
            s.first_name, s.last_name,
            COUNT(a.id) FILTER (WHERE a.present=true)::int AS trainings
          FROM students s
          JOIN attendances a ON a.student_id = s.id
          GROUP BY s.id
          ORDER BY trainings DESC
          LIMIT 10
        `);

        return res.status(200).json({ summary, byYear, topStudents });
      }

      return res.status(400).json({ error: 'Nieprawidłowy tab' });

    } catch (e) {
      console.error('[history]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // TRASA: /api/admin-api/registrations  →  nowe zapisy
  // ══════════════════════════════════════════════════════════════

  const { id, search, status, payment_status, group_id, page = 1, limit = 50 } = req.query;

  // ── GET pojedynczy zapis ──────────────────────────────────────
  if (req.method === 'GET' && id) {
    try {
      const { rows: [r] } = await pool.query(`
        SELECT r.*,
          g.name AS group_name, l.city, l.name AS location_name,
          pp.name AS plan_name,
          s.day_name, s.time_start, s.time_end, s.address AS schedule_address
        FROM registrations r
        LEFT JOIN groups g ON g.id = r.group_id
        LEFT JOIN locations l ON l.id = r.location_id
        LEFT JOIN price_plans pp ON pp.id = r.price_plan_id
        LEFT JOIN schedules s ON s.id = r.schedule_id
        WHERE r.id = $1
      `, [parseInt(id)]);
      if (!r) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET lista zapisów ─────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const conditions = [];
      const vals = [];
      let pi = 1;

      if (search) {
        conditions.push(`(r.first_name ILIKE $${pi} OR r.last_name ILIKE $${pi} OR r.email ILIKE $${pi} OR r.payment_ref ILIKE $${pi})`);
        vals.push(`%${search}%`);
        pi++;
      }
      if (status) { conditions.push(`r.status = $${pi++}`); vals.push(status); }
      if (payment_status) { conditions.push(`r.payment_status = $${pi++}`); vals.push(payment_status); }
      if (group_id) { conditions.push(`r.group_id = $${pi++}`); vals.push(parseInt(group_id)); }

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const { rows: [{ total }] } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM registrations r ${where}`, vals
      );

      const { rows } = await pool.query(`
        SELECT r.id, r.first_name, r.last_name, r.email, r.phone,
               r.status, r.payment_status, r.payment_ref, r.total_amount,
               r.is_waitlist, r.source, r.created_at, r.admin_notes,
               r.has_membership, r.is_new,
               g.name AS group_name, l.city,
               pp.name AS plan_name
        FROM registrations r
        LEFT JOIN groups g ON g.id = r.group_id
        LEFT JOIN locations l ON l.id = r.location_id
        LEFT JOIN price_plans pp ON pp.id = r.price_plan_id
        ${where}
        ORDER BY r.created_at DESC
        LIMIT $${pi} OFFSET $${pi + 1}
      `, [...vals, parseInt(limit), offset]);

      return res.status(200).json({ rows, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (e) {
      console.error('[registrations GET]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH aktualizacja zapisu ─────────────────────────────────
  if (req.method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'Brak id.' });
    try {
      const b = req.body || {};
      const ALLOWED = ['status', 'payment_status', 'payment_method', 'admin_notes', 'is_waitlist', 'group_id', 'start_date'];
      const set = [], vals = [];
      let pi = 1;
      for (const key of ALLOWED) {
        if (key in b) { set.push(`${key}=$${pi++}`); vals.push(b[key]); }
      }
      if (!set.length) return res.status(400).json({ error: 'Brak pól do aktualizacji.' });
      set.push(`updated_at=NOW()`);
      vals.push(parseInt(id));
      await pool.query(`UPDATE registrations SET ${set.join(',')} WHERE id=$${pi}`, vals);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
