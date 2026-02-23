// api/instructor/panel.js  — FUNKCJA #11

const { getPool } = require('../_lib/db');
const { getInstructor } = require('./auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const pool = getPool();

  // ─────────────────────────────────────────────
  // NOWY PANEL PO KODZIE (BEZ JWT)
  // ─────────────────────────────────────────────
  if (req.query.code) {
    try {
      const code = req.query.code;

      // 1️⃣ Lista zajęć instruktora
      if (!req.query.session_id && req.method === 'GET') {
        const { rows } = await pool.query(
          `
          SELECT
            access_code,
            session_id,
            session_date,
            group_id,
            group_name,
            location
          FROM instructor_panel_view
          WHERE access_code = $1
          ORDER BY session_date DESC
          `,
          [code]
        );
        return res.status(200).json({ rows });
      }

      // 2️⃣ Lista kursantów na zajęcia
      if (req.query.session_id && req.method === 'GET') {
        const { rows } = await pool.query(
          `
          SELECT
            v.session_id,
            v.session_date,
            v.group_name,
            v.location,
            v.student_id,
            v.first_name,
            v.last_name,
            v.present,
            v.last_payment
          FROM instructor_attendance_view v
          JOIN instructor_login_view il ON il.group_id = v.group_id
          WHERE il.access_code = $1
            AND v.session_id = $2
          ORDER BY v.last_name, v.first_name
          `,
          [code, parseInt(req.query.session_id)]
        );
        return res.status(200).json({ rows });
      }

      // 3️⃣ Zapis obecności
      if (req.method === 'POST') {
        const { session_id, student_id, present } = req.body;

        const { rows: [access] } = await pool.query(
          `
          SELECT 1
          FROM instructor_panel_view
          WHERE access_code = $1
            AND session_id = $2
          `,
          [code, parseInt(session_id)]
        );

        if (!access) {
          return res.status(403).json({ error: 'Brak dostępu.' });
        }

        await pool.query(
          `
          INSERT INTO attendances (session_id, student_id, present)
          VALUES ($1, $2, $3)
          ON CONFLICT (session_id, student_id)
          DO UPDATE SET present = EXCLUDED.present
          `,
          [parseInt(session_id), parseInt(student_id), !!present]
        );

        return res.status(200).json({ success: true });
      }

    } catch (e) {
      console.error('[code-panel]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ─────────────────────────────────────────────
  // STARA LOGIKA JWT (NIC NIE RUSZAMY)
  // ─────────────────────────────────────────────
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let instructor;
  try { instructor = getInstructor(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const { _route: route, id } = req.query;
  const instructorId = instructor.sub;

  if (route === 'groups') {
    const { rows } = await pool.query(`
      SELECT g.id, g.name
      FROM instructor_groups ig
      JOIN groups g ON g.id = ig.group_id
      WHERE ig.instructor_id = $1
      ORDER BY g.name
    `, [instructorId]);
    return res.status(200).json({ rows });
  }

  return res.status(400).json({ error: 'Nieprawidłowa trasa.' });
};