// api/admin-api/students.js  — FUNKCJA #9
// Ujednolicona baza kursantów + FILTR SEZONU 2025/2026

const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const { id, search, source, group_id, city,
          payment_status, is_active,
          page = 1, limit = 60, sort = 'recent',
          season } = req.query;

  // ─────────────────────────────────────────────
  // GET LISTA – WERSJA SEZONOWA
  // ─────────────────────────────────────────────
  if (req.method === 'GET' && !id) {
    try {
      const conds = [];
      const vals = [];
      let pi = 1;

      if (search) {
        conds.push(`(s.first_name ILIKE $${pi} OR s.last_name ILIKE $${pi} OR s.email ILIKE $${pi} OR s.phone ILIKE $${pi})`);
        vals.push(`%${search}%`);
        pi++;
      }

      if (source && source !== 'all') {
        conds.push(`s.source = $${pi++}`);
        vals.push(source);
      }

      if (is_active !== undefined && is_active !== '') {
        conds.push(`s.is_active = $${pi++}`);
        vals.push(is_active === 'true');
      }

      if (group_id) {
        conds.push(`EXISTS(SELECT 1 FROM student_groups sg2 WHERE sg2.student_id = s.id AND sg2.group_id = $${pi++})`);
        vals.push(parseInt(group_id));
      }

      if (city) {
        conds.push(`EXISTS(
          SELECT 1
          FROM student_groups sg3
          JOIN groups g3 ON g3.id = sg3.group_id
          JOIN locations l3 ON l3.id = g3.location_id
          WHERE sg3.student_id = s.id
            AND l3.city ILIKE $${pi++}
        )`);
        vals.push(`%${city}%`);
      }

      if (payment_status && payment_status !== 'all') {
        conds.push(`EXISTS(
          SELECT 1 FROM registrations r2
          WHERE r2.id = s.registration_id
            AND r2.payment_status = $${pi++}
        )`);
        vals.push(payment_status);
      }

      // ─── KLUCZOWE: FILTR SEZONU 2025/2026 ───
      if (season === '2025') {
        conds.push(`
          EXISTS (
            SELECT 1
            FROM attendances a2
            JOIN training_sessions ts2 ON ts2.id = a2.session_id
            WHERE a2.student_id = s.id
              AND ts2.session_date >= DATE '2025-09-01'
              AND ts2.session_date <= DATE '2026-02-23'
          )
        `);
      }

      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const { rows: [{ total }] } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM students s ${where}`,
        vals
      );

      const { rows } = await pool.query(`
        SELECT
          s.id,
          s.legacy_id,
          s.first_name,
          s.last_name,
          s.email,
          s.phone,
          s.is_active,
          MAX(ts.session_date) AS last_training,
          COUNT(DISTINCT a.id) FILTER (WHERE a.present = true) AS total_present,
          COUNT(DISTINCT a.id) AS total_sessions,
          MAX(lp.paid_at) AS last_payment_date,
          COALESCE(SUM(lp.amount), 0)::numeric AS legacy_paid,
          l.city
        FROM students s
        LEFT JOIN attendances a ON a.student_id = s.id
        LEFT JOIN training_sessions ts ON ts.id = a.session_id
        LEFT JOIN legacy_payments lp ON lp.student_id = s.id
        LEFT JOIN student_groups sg ON sg.student_id = s.id
        LEFT JOIN groups g ON g.id = sg.group_id
        LEFT JOIN locations l ON l.id = g.location_id
        ${where}
        GROUP BY s.id, l.city
        ORDER BY MAX(ts.session_date) DESC NULLS LAST
        LIMIT $${pi} OFFSET $${pi + 1}
      `, [...vals, parseInt(limit), offset]);

      return res.status(200).json({ rows, total, page: parseInt(page), limit: parseInt(limit) });

    } catch (e) {
      console.error('[students GET list]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};