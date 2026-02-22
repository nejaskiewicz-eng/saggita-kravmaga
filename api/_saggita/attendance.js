// api/instructor/attendance.js  — FUNKCJA #12
// Routing przez ?_route=:
//   sessions    → GET  /api/instructor/sessions?group_id=X
//                  POST /api/instructor/sessions         (nowa sesja)
//   attendance  → GET  /api/instructor/sessions/:id/attendance
//                  POST /api/instructor/sessions/:id/attendance (zapisz bulk)

const { getPool } = require('../_lib/db');
const { getInstructor } = require('./auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let instructor;
  try { instructor = getInstructor(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const { _route: route, id, group_id } = req.query;
  const instructorId = instructor.sub;

  // Helper: sprawdź dostęp instruktora do grupy
  async function checkGroupAccess(gid) {
    const { rows: [r] } = await pool.query(
      `SELECT 1 FROM instructor_groups WHERE instructor_id = $1 AND group_id = $2`,
      [instructorId, parseInt(gid)]
    );
    return !!r;
  }

  // Helper: sprawdź dostęp instruktora do sesji (przez grupę)
  async function checkSessionAccess(sessionId) {
    const { rows: [r] } = await pool.query(`
      SELECT ts.group_id FROM training_sessions ts
      JOIN instructor_groups ig ON ig.group_id = ts.group_id
      WHERE ts.id = $1 AND ig.instructor_id = $2
    `, [parseInt(sessionId), instructorId]);
    return r ? r.group_id : null;
  }

  // ══════════════════════════════════════════════════════════════
  // SESJE
  // ══════════════════════════════════════════════════════════════
  if (route === 'sessions') {

    // ── GET lista sesji grupy ─────────────────────────────────────
    if (req.method === 'GET') {
      if (!group_id) return res.status(400).json({ error: 'Podaj group_id.' });
      if (!await checkGroupAccess(group_id)) {
        return res.status(403).json({ error: 'Brak dostępu do tej grupy.' });
      }

      try {
        const { rows } = await pool.query(`
          SELECT
            ts.id, ts.session_date, ts.notes, ts.created_at,
            i.first_name AS instructor_first, i.last_name AS instructor_last,
            COUNT(a.id)::int AS total_students,
            COUNT(a.id) FILTER (WHERE a.present = true)::int AS present_count,
            ROUND(
              COUNT(a.id) FILTER (WHERE a.present = true)::numeric /
              NULLIF(COUNT(a.id), 0) * 100, 0
            )::int AS attendance_pct
          FROM training_sessions ts
          LEFT JOIN attendances a ON a.session_id = ts.id
          LEFT JOIN instructors i ON i.id = ts.created_by
          WHERE ts.group_id = $1
          GROUP BY ts.id, i.id
          ORDER BY ts.session_date DESC
          LIMIT 50
        `, [parseInt(group_id)]);

        return res.status(200).json({ rows });
      } catch (e) {
        console.error('[sessions GET]', e);
        return res.status(500).json({ error: e.message });
      }
    }

    // ── POST utwórz nową sesję ────────────────────────────────────
    if (req.method === 'POST') {
      try {
        const b = req.body || {};
        if (!b.group_id) return res.status(400).json({ error: 'Podaj group_id.' });
        if (!b.session_date) return res.status(400).json({ error: 'Podaj datę sesji.' });

        if (!await checkGroupAccess(b.group_id)) {
          return res.status(403).json({ error: 'Brak dostępu do tej grupy.' });
        }

        // Sprawdź czy sesja na tę datę już istnieje
        const { rows: [existing] } = await pool.query(
          `SELECT id FROM training_sessions WHERE group_id = $1 AND session_date = $2`,
          [parseInt(b.group_id), b.session_date]
        );
        if (existing) {
          return res.status(409).json({ 
            error: 'Sesja dla tej grupy w tym dniu już istnieje.',
            existing_session_id: existing.id
          });
        }

        const { rows: [session] } = await pool.query(`
          INSERT INTO training_sessions (group_id, session_date, notes, created_by)
          VALUES ($1, $2, $3, $4)
          RETURNING *
        `, [parseInt(b.group_id), b.session_date, b.notes || null, instructorId]);

        // Automatycznie utwórz wpisy obecności dla wszystkich kursantów grupy
        const { rows: students } = await pool.query(`
          SELECT s.id FROM student_groups sg
          JOIN students s ON s.id = sg.student_id
          WHERE sg.group_id = $1 AND sg.active = true
        `, [parseInt(b.group_id)]);

        // Też kursanci z rejestracji
        const { rows: regStudents } = await pool.query(`
          SELECT r.id AS reg_id, r.first_name, r.last_name
          FROM registrations r
          WHERE r.group_id = $1 AND r.status != 'cancelled' AND r.is_waitlist = false
        `, [parseInt(b.group_id)]);

        if (students.length > 0) {
          const attendanceValues = students.map((s, i) => 
            `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
          ).join(', ');
          const attendanceParams = students.flatMap(s => [session.id, s.id, false, false]);
          
          await pool.query(`
            INSERT INTO attendances (session_id, student_id, present, diff_group)
            VALUES ${attendanceValues}
            ON CONFLICT (session_id, student_id) DO NOTHING
          `, attendanceParams);
        }

        return res.status(201).json({ 
          session,
          students_added: students.length,
          registered_students: regStudents,
        });
      } catch (e) {
        console.error('[sessions POST]', e);
        return res.status(500).json({ error: e.message });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // OBECNOŚCI konkretnej sesji
  // ══════════════════════════════════════════════════════════════
  if (route === 'attendance') {
    if (!id) return res.status(400).json({ error: 'Brak id sesji.' });

    const groupId = await checkSessionAccess(id);
    if (!groupId) return res.status(403).json({ error: 'Brak dostępu do tej sesji.' });

    // ── GET lista obecności sesji ─────────────────────────────────
    if (req.method === 'GET') {
      try {
        const { rows: session } = await pool.query(`
          SELECT ts.*, g.name AS group_name, l.city
          FROM training_sessions ts
          LEFT JOIN groups g ON g.id = ts.group_id
          LEFT JOIN locations l ON l.id = g.location_id
          WHERE ts.id = $1
        `, [parseInt(id)]);

        // Legacy kursanci
        const { rows: legacyAttendances } = await pool.query(`
          SELECT
            a.id AS attendance_id, a.student_id, a.present, a.diff_group,
            s.first_name, s.last_name, s.legacy_id,
            'legacy' AS source
          FROM attendances a
          JOIN students s ON s.id = a.student_id
          WHERE a.session_id = $1
          ORDER BY s.last_name, s.first_name
        `, [parseInt(id)]);

        // Nowi kursanci (z rejestracji) — nie mają wpisów w attendances
        const { rows: newStudents } = await pool.query(`
          SELECT
            r.id AS registration_id,
            r.first_name, r.last_name,
            r.payment_status,
            'registration' AS source,
            -- Sprawdź czy jest wpis obecności
            (SELECT a2.present FROM attendances a2 
             JOIN students s2 ON s2.id = a2.student_id
             WHERE a2.session_id = $1 
               AND s2.email = r.email
             LIMIT 1) AS present
          FROM registrations r
          WHERE r.group_id = $2 AND r.status != 'cancelled' AND r.is_waitlist = false
          ORDER BY r.last_name, r.first_name
        `, [parseInt(id), groupId]);

        return res.status(200).json({
          session: session[0],
          legacy: legacyAttendances,
          registered: newStudents,
        });
      } catch (e) {
        console.error('[attendance GET]', e);
        return res.status(500).json({ error: e.message });
      }
    }

    // ── POST zapisz obecności (bulk) ──────────────────────────────
    if (req.method === 'POST') {
      try {
        const { attendances } = req.body || {};
        // attendances = [{ student_id, present, diff_group? }, ...]
        
        if (!Array.isArray(attendances) || attendances.length === 0) {
          return res.status(400).json({ error: 'Podaj tablicę attendances.' });
        }

        let updated = 0;
        for (const a of attendances) {
          if (!a.student_id) continue;
          await pool.query(`
            INSERT INTO attendances (session_id, student_id, present, diff_group, marked_by)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (session_id, student_id) DO UPDATE SET
              present = EXCLUDED.present,
              diff_group = EXCLUDED.diff_group,
              marked_by = EXCLUDED.marked_by
          `, [
            parseInt(id),
            parseInt(a.student_id),
            a.present === true || a.present === 1,
            a.diff_group || false,
            instructorId,
          ]);
          updated++;
        }

        // Zaktualizuj notes sesji jeśli podano
        if (req.body.session_notes !== undefined) {
          await pool.query(
            `UPDATE training_sessions SET notes = $1 WHERE id = $2`,
            [req.body.session_notes, parseInt(id)]
          );
        }

        return res.status(200).json({ success: true, updated });
      } catch (e) {
        console.error('[attendance POST]', e);
        return res.status(500).json({ error: e.message });
      }
    }
  }

  return res.status(400).json({ error: 'Nieprawidłowa trasa.' });
};
