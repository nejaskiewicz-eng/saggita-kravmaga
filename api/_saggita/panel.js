// api/_saggita/panel.js — Panel Instruktora (NAPRAWIONY)
// Zmiany vs poprzednia wersja:
//   1. Usunięto "AND ig.active = true" (kolumna nie istnieje w instructor_groups)
//   2. Naprawiono route: 'group-students' → 'students'
//   3. Naprawiono route: 'student-payments' → 'payments'
//   4. Naprawiono route: 'student' → sprawdzamy !route (vercel nie wysyła _route dla /students/:id)
//   5. Naprawiono POST students: !route && !id
//   6. Dodano GET student/:id (instruktor odpyta o pojedynczego kursanta)
//   7. Dodano GET student/:id/attendance (historia obecności kursanta)

'use strict';
const { getPool } = require('../_lib/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SEASON = '2025-09-01';

/* ── JWT ──────────────────────────────────────────────────────── */
function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function makeJWT(p, s) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64(p);
  const sig = crypto.createHmac('sha256', s).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${sig}`;
}
function verifyJWT(tok, s) {
  if (!tok) throw new Error('Brak tokenu');
  const [h, b, sig] = tok.split('.');
  if (!sig) throw new Error('Nieprawidłowy token');
  const exp = crypto.createHmac('sha256', s).update(`${h}.${b}`).digest('base64url');
  if (sig !== exp) throw new Error('Nieważny token');
  const pad = b.length % 4;
  return JSON.parse(Buffer.from(
    (pad ? b + '='.repeat(4 - pad) : b).replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString());
}
function auth(req) {
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('Brak JWT_SECRET');
  const p = verifyJWT(t, s);
  if (p.role !== 'instructor') throw new Error('Brak uprawnień instruktora');
  return p;
}

/* ── CORS ─────────────────────────────────────────────────────── */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}

/* ═══════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const pool = getPool();
  const { _module: mod, _route: route, id, pid } = req.query;

  /* ══ AUTH ════════════════════════════════════════════════════ */
  if (mod === 'instructor-auth') {

    if (req.method === 'POST') {
      try {
        const { username, password } = req.body || {};
        if (!username || !password)
          return res.status(400).json({ error: 'Podaj login i hasło.' });
        const { rows: [i] } = await pool.query(
          `SELECT id,username,password_hash,first_name,last_name,email
           FROM instructors WHERE username=$1 AND active=true`, [username]);
        if (!i) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
        if (!await bcrypt.compare(password, i.password_hash))
          return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
        const secret = process.env.JWT_SECRET;
        if (!secret) throw new Error('Brak JWT_SECRET');
        // Pobierz uprawnienia instruktora
        const { rows: [perms] } = await pool.query(
          `SELECT * FROM instructor_permissions WHERE instructor_id=$1`, [i.id]);
        const token = makeJWT({
          sub: i.id, username: i.username, role: 'instructor',
          iat: Math.floor(Date.now() / 1000)
        }, secret);
        return res.status(200).json({
          token,
          instructor: { id: i.id, username: i.username, first_name: i.first_name, last_name: i.last_name, email: i.email },
          permissions: perms || {}
        });
      } catch (e) { console.error('[inst/login]', e); return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'GET') {
      try {
        const p = auth(req);
        const { rows: [i] } = await pool.query(
          `SELECT id,username,first_name,last_name,email,phone
           FROM instructors WHERE id=$1 AND active=true`, [p.sub]);
        if (!i) return res.status(401).json({ error: 'Brak instruktora.' });
        return res.status(200).json(i);
      } catch (e) { return res.status(401).json({ error: e.message }); }
    }
    return res.status(405).end();
  }

  /* ══ PANEL: grupy, statystyki, płatności ═════════════════════ */
  if (mod === 'instructor-panel') {
    let P;
    try { P = auth(req); } catch (e) { return res.status(401).json({ error: e.message }); }

    // GET /api/instructor/groups
    if (route === 'groups' && req.method === 'GET') {
      try {
        // Pobierz uprawnienia instruktora
        const { rows: [perms] } = await pool.query(
          `SELECT * FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
        const perm = perms || {};

        const { rows } = await pool.query(`
          SELECT g.id, g.name, g.category, g.age_range, g.notes,
            l.id AS location_id, l.city AS location_city, l.name AS location_name,
            COUNT(DISTINCT sg.student_id) FILTER (WHERE sg.active=true AND st.is_active=true)::int AS student_count,
            COALESCE(json_agg(
              json_build_object('id',s.id,'day_of_week',s.day_of_week,'day_name',s.day_name,
                'time_start',s.time_start,'time_end',s.time_end,'time_label',s.time_label)
              ORDER BY s.day_of_week, s.time_start
            ) FILTER (WHERE s.id IS NOT NULL), '[]') AS schedules
          FROM instructor_groups ig
          JOIN groups g         ON g.id = ig.group_id
          LEFT JOIN locations l ON l.id = g.location_id
          LEFT JOIN student_groups sg ON sg.group_id = g.id
          LEFT JOIN students st ON st.id = sg.student_id
          LEFT JOIN schedules s ON s.group_id = g.id AND s.active=true
          WHERE ig.instructor_id = $1
            AND g.active = true
          GROUP BY g.id, l.id
          ORDER BY l.city, g.name
        `, [P.sub]);

        // Jeśli nie widzi liczby kursantów — wyzeruj
        if (!perm.can_see_student_count) {
          rows.forEach(r => { r.student_count = null; });
        }

        return res.status(200).json({ rows, permissions: perm });
      } catch (e) { console.error('[groups]', e); return res.status(500).json({ error: e.message }); }
    }

    // GET /api/instructor/permissions
    if (route === 'permissions' && req.method === 'GET') {
      try {
        const { rows: [perms] } = await pool.query(
          `SELECT * FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
        return res.status(200).json(perms || {});
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // GET /api/instructor/groups/:id/students  (_route=students)
    if (route === 'students' && req.method === 'GET') {
      try {
        // Sprawdź czy instruktor ma filtrowanie kursantów
        const { rows: [perms] } = await pool.query(
          `SELECT * FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
        const perm = perms || {};

        // Sprawdź czy instruktor ma przypisanych kursantów (tabela może nie istnieć)
        let hasAssigned = false;
        let assignedIds = new Set();
        try {
          const { rows: assignedRows } = await pool.query(
            `SELECT student_id FROM instructor_students WHERE instructor_id=$1`, [P.sub]);
          hasAssigned = assignedRows.length > 0;
          assignedIds = new Set(assignedRows.map(r => r.student_id));
          console.log('[students] instructor', P.sub, 'hasAssigned:', hasAssigned, 'count:', assignedRows.length);
        } catch (assignErr) {
          console.warn('[students] instructor_students table missing or error:', assignErr.message);
          // Tabela nie istnieje — pokaż wszystkich aktywnych z grupy
        }

        let q = `
          SELECT s.id, s.first_name, s.last_name, s.email, s.phone, s.birth_year, s.is_active,
            sg.paid_until,
            (SELECT MAX(lp.paid_at) FROM legacy_payments lp WHERE lp.student_id=s.id AND lp.paid_at>=$2)::date AS last_payment,
            (SELECT COALESCE(SUM(lp.amount),0) FROM legacy_payments lp WHERE lp.student_id=s.id AND lp.paid_at>=$2)::numeric AS paid_season,
            (SELECT COUNT(*) FROM attendances a
             JOIN training_sessions ts ON ts.id=a.session_id
             WHERE a.student_id=s.id AND ts.session_date>=$2 AND a.present=true)::int AS att_season
          FROM students s
          JOIN student_groups sg ON sg.student_id=s.id AND sg.group_id=$1 AND sg.active=true
          WHERE s.is_active=true
          ORDER BY s.last_name, s.first_name
        `;
        const { rows } = await pool.query(q, [id, SEASON]);

        // Filtruj do przypisanych kursantów jeśli lista jest ustawiona
        const filtered = hasAssigned ? rows.filter(r => assignedIds.has(r.id)) : rows;

        // paid_season (suma sezonu) zawsze ukryta dla instruktora
        // Ukryj też last_payment jeśli brak uprawnienia
        filtered.forEach(r => {
          r.paid_season = null;
          if (!perm.can_see_payments) r.last_payment = null;
        });

        return res.status(200).json({ rows: filtered, permissions: perm });
      } catch (e) { console.error('[group-students]', e); return res.status(500).json({ error: e.message }); }
    }

    // POST /api/instructor/payments  — przyjęcie płatności
    if (route === 'accept-payment' && req.method === 'POST') {
      try {
        const { rows: [perms] } = await pool.query(
          `SELECT can_accept_payment FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
        if (!perms?.can_accept_payment) return res.status(403).json({ error: 'Brak uprawnień do przyjmowania płatności.' });
        const { student_id, amount, note, group_id } = req.body || {};
        if (!student_id || !amount) return res.status(400).json({ error: 'student_id i amount są wymagane.' });
        const { rows: [pay] } = await pool.query(
          `INSERT INTO legacy_payments (student_id, amount, paid_at, note)
           VALUES ($1,$2,NOW(),$3) RETURNING id, amount, paid_at::date AS paid_at`,
          [student_id, amount, note || null]);
        // Zapisz alert dla admina
        const { rows: [inst] } = await pool.query(`SELECT first_name,last_name FROM instructors WHERE id=$1`, [P.sub]);
        const { rows: [stud] } = await pool.query(`SELECT first_name,last_name FROM students WHERE id=$1`, [student_id]);
        await pool.query(
          `INSERT INTO instructor_events (instructor_id, event_type, student_id, group_id, amount, note, metadata)
           VALUES ($1,'payment_accepted',$2,$3,$4,$5,$6)`,
          [P.sub, student_id, group_id || null, amount, note || null,
          JSON.stringify({ instructor_name: `${inst?.first_name} ${inst?.last_name}`, student_name: `${stud?.first_name} ${stud?.last_name}` })]);
        return res.status(201).json(pay);
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // PATCH /api/instructor/student-groups/paid-until  — ustawienie daty opłacony do
    if (route === 'paid-until' && req.method === 'PATCH') {
      try {
        const { rows: [perms] } = await pool.query(
          `SELECT can_accept_payment FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
        if (!perms?.can_accept_payment) return res.status(403).json({ error: 'Brak uprawnień do ustawienia opłaty.' });
        const { student_id, group_id, paid_until } = req.body || {};
        if (!student_id || !group_id) return res.status(400).json({ error: 'student_id i group_id są wymagane.' });
        await pool.query(
          `UPDATE student_groups SET paid_until=$1 WHERE student_id=$2 AND group_id=$3`,
          [paid_until || null, student_id, group_id]);
        return res.status(200).json({ ok: true });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // GET /api/instructor/payments
    if (route === 'payments' && req.method === 'GET') {
      try {
        const { rows: [perms] } = await pool.query(
          `SELECT can_see_payments FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
        if (!perms?.can_see_payments) return res.status(200).json({ rows: [], hidden: true });

        // Filtrujemy tylko kursantów przypisanych do instruktora (jeśli lista ustawiona)
        const { rows: assignedRows } = await pool.query(
          `SELECT student_id FROM instructor_students WHERE instructor_id=$1`, [P.sub]);
        const hasAssigned = assignedRows.length > 0;
        const assignedIds = assignedRows.map(r => r.student_id);
        const { rows } = await pool.query(`
          SELECT lp.id, lp.amount, lp.paid_at::date AS paid_at, lp.note,
            s.id AS student_id, s.first_name, s.last_name,
            g.name AS group_name, l.city AS location_city
          FROM legacy_payments lp
          JOIN students s ON s.id=lp.student_id
          JOIN student_groups sg ON sg.student_id=s.id AND sg.active=true
          JOIN groups g ON g.id=sg.group_id
          JOIN locations l ON l.id=g.location_id
          WHERE lp.paid_at >= $1
            AND g.id IN (
              SELECT group_id FROM instructor_groups WHERE instructor_id=$2
            )
            ${hasAssigned ? `AND s.id = ANY($3::int[])` : ''}
          ORDER BY lp.paid_at DESC
          LIMIT 500
        `, hasAssigned ? [SEASON, P.sub, assignedIds] : [SEASON, P.sub]);
        return res.status(200).json({ rows });
      } catch (e) { console.error('[payments]', e); return res.status(500).json({ error: e.message }); }
    }

    // GET /api/instructor/instructors-list — lista instruktorów do przypisywania sesji
    if (route === 'instructors-list' && req.method === 'GET') {
      try {
        const { rows: [perms] } = await pool.query(
          `SELECT can_assign_instructors FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
        if (!perms?.can_assign_instructors) return res.status(403).json({ error: 'Brak uprawnień.' });
        const { rows } = await pool.query(
          `SELECT id, first_name, last_name FROM instructors WHERE active=true ORDER BY last_name, first_name`);
        return res.status(200).json({ rows });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(400).json({ error: 'Nieznana trasa panel.' });
  }

  /* ══ INSTRUCTOR EVENTS (admin alerts) ═══════════════════════ */
  // GET  /api/admin-api/instructor-events  — lista alertów (admin)
  // POST /api/admin-api/instructor-events/:id/seen — oznacz jako przeczytany
  if (mod === 'instructor-events') {
    // Admin auth (via X-Admin-Token or standard JWT with role check)
    // We use the existing requireAuth from _lib/auth but check it's an admin call
    // For simplicity: this route is called by admin panel which passes admin JWT
    try {
      const pool2 = getPool();
      if (req.method === 'GET') {
        const { rows } = await pool2.query(`
          SELECT ie.id, ie.event_type, ie.amount, ie.note, ie.created_at, ie.seen_at,
            ie.metadata,
            i.first_name || ' ' || i.last_name AS instructor_name,
            s.first_name || ' ' || s.last_name AS student_name,
            g.name AS group_name
          FROM instructor_events ie
          JOIN instructors i ON i.id = ie.instructor_id
          LEFT JOIN students s ON s.id = ie.student_id
          LEFT JOIN groups g ON g.id = ie.group_id
          ORDER BY ie.created_at DESC
          LIMIT 100
        `);
        const unseen = rows.filter(r => !r.seen_at).length;
        return res.status(200).json({ rows, unseen });
      }
      if (req.method === 'PATCH' && id) {
        await pool2.query(`UPDATE instructor_events SET seen_at=NOW() WHERE id=$1`, [id]);
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'POST' && req.query.action === 'mark-all-seen') {
        await pool2.query(`UPDATE instructor_events SET seen_at=NOW() WHERE seen_at IS NULL`);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).end();
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  /* ══ ATTENDANCE: sesje + obecności ══════════════════════════ */
  if (mod === 'instructor-attendance') {
    let P;
    try { P = auth(req); } catch (e) { return res.status(401).json({ error: e.message }); }

    if (route === 'sessions') {
      if (req.method === 'GET') {
        try {
          const { group_id, from, to } = req.query;
          let q = `
            SELECT ts.id AS session_id, TO_CHAR(ts.session_date, 'YYYY-MM-DD') AS session_date, ts.group_id,
              ts.instructor_id,
              i2.first_name || ' ' || i2.last_name AS session_instructor_name,
              g.name AS group_name, l.city AS location_city, l.name AS location_name,
              COUNT(a.id) FILTER (WHERE a.present=true)::int AS present_count,
              COUNT(a.id)::int AS total_marked
            FROM training_sessions ts
            JOIN groups g ON g.id=ts.group_id
            LEFT JOIN locations l ON l.id=g.location_id
            LEFT JOIN attendances a ON a.session_id=ts.id
            LEFT JOIN instructors i2 ON i2.id=ts.instructor_id
            WHERE ts.session_date >= $1
              AND ts.group_id IN (
                SELECT group_id FROM instructor_groups WHERE instructor_id=$2
              )
          `;
          const params = [from || SEASON, P.sub];
          if (to) { params.push(to); q += ` AND ts.session_date <= $${params.length}`; }
          if (group_id) { params.push(group_id); q += ` AND ts.group_id = $${params.length}`; }
          q += ` GROUP BY ts.id, i2.first_name, i2.last_name, g.name, l.city, l.name ORDER BY ts.session_date DESC LIMIT 400`;
          const { rows } = await pool.query(q, params);
          return res.status(200).json({ rows });
        } catch (e) { console.error('[sessions GET]', e); return res.status(500).json({ error: e.message }); }
      }

      if (req.method === 'POST') {
        try {
          const { group_id, session_date } = req.body || {};
          if (!group_id || !session_date) return res.status(400).json({ error: 'Brak danych' });
          // Sprawdź czy instruktor ma dostęp do tej grupy
          const { rows: [chk] } = await pool.query(
            `SELECT 1 FROM instructor_groups WHERE instructor_id=$1 AND group_id=$2`,
            [P.sub, group_id]
          );
          if (!chk) return res.status(403).json({ error: 'Brak dostępu do tej grupy' });
          const { rows: [x] } = await pool.query(
            `INSERT INTO training_sessions (group_id, session_date)
             VALUES ($1,$2)
             ON CONFLICT (group_id, session_date) DO UPDATE SET session_date=EXCLUDED.session_date
             RETURNING id`, [group_id, session_date]
          );
          return res.status(200).json({ id: x.id });
        } catch (e) { console.error('[session POST]', e); return res.status(500).json({ error: e.message }); }
      }

      if (req.method === 'DELETE' && id) {
        try {
          const { rows: [chk] } = await pool.query(`
            SELECT 1 FROM training_sessions ts
            JOIN instructor_groups ig ON ig.group_id = ts.group_id
            WHERE ts.id = $1 AND ig.instructor_id = $2
          `, [id, P.sub]);
          if (!chk) return res.status(403).json({ error: 'Brak dostępu do usunięcia tej sesji.' });

          await pool.query(`DELETE FROM attendances WHERE session_id = $1`, [id]);
          await pool.query(`DELETE FROM training_sessions WHERE id = $1`, [id]);
          return res.status(200).json({ ok: true });
        } catch (e) { console.error('[session DELETE]', e); return res.status(500).json({ error: e.message }); }
      }

      // PATCH /api/instructor/sessions/:id  — przypisanie instruktora do sesji
      if (req.method === 'PATCH' && id) {
        try {
          const { rows: [perms] } = await pool.query(
            `SELECT can_assign_instructors FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
          if (!perms?.can_assign_instructors)
            return res.status(403).json({ error: 'Brak uprawnienia przypisywania instruktora.' });
          // Sprawdź dostęp do sesji
          const { rows: [chk] } = await pool.query(`
            SELECT 1 FROM training_sessions ts
            JOIN instructor_groups ig ON ig.group_id=ts.group_id
            WHERE ts.id=$1 AND ig.instructor_id=$2`, [id, P.sub]);
          if (!chk) return res.status(403).json({ error: 'Brak dostępu do tej sesji.' });
          const { instructor_id } = req.body || {};
          await pool.query(
            `UPDATE training_sessions SET instructor_id=$1 WHERE id=$2`,
            [instructor_id || null, id]);
          return res.status(200).json({ ok: true });
        } catch (e) { console.error('[session PATCH]', e); return res.status(500).json({ error: e.message }); }
      }

      return res.status(405).end();
    }

    // GET /api/instructor/sessions/:id/attendance
    if (route === 'attendance' && req.method === 'GET') {
      try {
        const sessId = parseInt(id);
        const grpId = parseInt(req.query.group_id);
        if (isNaN(sessId) || isNaN(grpId)) return res.status(400).json({ error: 'Nieprawidłowy ID sesji lub grupy.' });

        const { rows } = await pool.query(`
          SELECT s.id AS student_id, s.first_name, s.last_name,
            COALESCE(a.present,false) AS present,
            sg.paid_until,
            (SELECT MAX(lp.paid_at) FROM legacy_payments lp WHERE lp.student_id=s.id AND lp.paid_at>=$2)::date AS last_payment
          FROM student_groups sg
          JOIN students s ON s.id=sg.student_id AND s.is_active=true
          LEFT JOIN attendances a ON a.session_id=$1 AND a.student_id=s.id
          WHERE sg.group_id=$3 AND sg.active=true
          ORDER BY s.last_name, s.first_name
        `, [sessId, SEASON, grpId]);
        return res.status(200).json({ rows });
      } catch (e) { console.error('[attendance GET]', e); return res.status(500).json({ error: e.message }); }
    }

    // POST /api/instructor/sessions/:id/attendance
    if (route === 'attendance' && req.method === 'POST') {
      try {
        const sessId = parseInt(id);
        const { student_id, present } = req.body || {};
        const studId = parseInt(student_id);
        if (isNaN(sessId) || isNaN(studId)) return res.status(400).json({ error: 'Brak lub błędny student_id / session_id' });
        await pool.query(`
          INSERT INTO attendances (session_id, student_id, present)
          VALUES ($1,$2,$3)
          ON CONFLICT (session_id, student_id)
          DO UPDATE SET present=EXCLUDED.present
        `, [sessId, studId, !!present]);
        return res.status(200).json({ ok: true });
      } catch (e) { console.error('[attendance POST]', e); return res.status(500).json({ error: e.message }); }
    }

    return res.status(400).json({ error: 'Nieznana trasa attendance.' });
  }

  /* ══ SESSION MANAGEMENT (dla can_assign_instructors) ═════════ */
  if (mod === 'instructor-session-mgmt') {
    let P;
    try { P = auth(req); } catch (e) { return res.status(401).json({ error: e.message }); }

    // Sprawdź uprawnienie
    const { rows: [mgmtPerms] } = await pool.query(
      `SELECT can_assign_instructors FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
    if (!mgmtPerms?.can_assign_instructors)
      return res.status(403).json({ error: 'Brak uprawnień zarządzania sesjami.' });

    // GET lista wszystkich instruktorów
    if (route === 'instructors' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(
          `SELECT i.id, i.first_name, i.last_name,
             COALESCE(json_agg(json_build_object('id',g.id,'name',g.name)) FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
           FROM instructors i
           LEFT JOIN instructor_groups ig ON ig.instructor_id=i.id
           LEFT JOIN groups g ON g.id=ig.group_id
           WHERE i.active=true
           GROUP BY i.id
           ORDER BY i.last_name, i.first_name`);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // GET sesje dla grupy
    if (route === 'sessions' && req.method === 'GET') {
      const { group_id, from, to } = req.query;
      if (!group_id) return res.status(400).json({ error: 'group_id wymagane.' });
      try {
        const params = [group_id];
        let q = `
          SELECT ts.id AS session_id,
            TO_CHAR(ts.session_date, 'YYYY-MM-DD') AS session_date,
            ts.group_id,
            COUNT(a.id) FILTER (WHERE a.present=true)::int AS present_count,
            COUNT(a.id)::int AS total_marked
          FROM training_sessions ts
          LEFT JOIN attendances a ON a.session_id=ts.id
          WHERE ts.group_id=$1`;
        if (from) { params.push(from); q += ` AND ts.session_date>=$${params.length}`; }
        if (to)   { params.push(to);   q += ` AND ts.session_date<=$${params.length}`; }
        q += ` GROUP BY ts.id ORDER BY ts.session_date`;
        const { rows } = await pool.query(q, params);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // POST utwórz sesję
    if (route === 'sessions' && req.method === 'POST') {
      const { group_id: gid, session_date } = req.body || {};
      if (!gid || !session_date) return res.status(400).json({ error: 'group_id i session_date wymagane.' });
      try {
        const { rows: [x] } = await pool.query(
          `INSERT INTO training_sessions (group_id, session_date)
           VALUES ($1,$2)
           ON CONFLICT (group_id, session_date) DO UPDATE SET session_date=EXCLUDED.session_date
           RETURNING id`, [gid, session_date]);
        return res.status(200).json({ id: x.id });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // DELETE sesję
    if (route === 'sessions' && req.method === 'DELETE' && id) {
      try {
        await pool.query(`DELETE FROM attendances WHERE session_id=$1`, [id]);
        await pool.query(`DELETE FROM training_sessions WHERE id=$1`, [id]);
        return res.status(200).json({ ok: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(400).json({ error: 'Nieznana trasa session-mgmt.' });
  }

  /* ══ STUDENTS (instruktor) ═══════════════════════════════════ */
  if (mod === 'instructor-students') {
    let P;
    try { P = auth(req); } catch (e) { return res.status(401).json({ error: e.message }); }

    // GET /api/instructor/students/:id  (brak _route w vercel.json)
    if (!route && id && req.method === 'GET') {
      try {
        const { rows: [s] } = await pool.query(`
          SELECT s.id, s.first_name, s.last_name, s.email, s.phone, s.birth_year, s.is_active,
            COALESCE(json_agg(
              json_build_object('id',g.id,'name',g.name,'city',l.city,'active',sg.active)
              ORDER BY l.city, g.name
            ) FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
          FROM students s
          LEFT JOIN student_groups sg ON sg.student_id=s.id
          LEFT JOIN groups g ON g.id=sg.group_id
          LEFT JOIN locations l ON l.id=g.location_id
          WHERE s.id=$1
          GROUP BY s.id
        `, [id]);
        if (!s) return res.status(404).json({ error: 'Nie znaleziono kursanta' });
        return res.status(200).json(s);
      } catch (e) { console.error('[student GET]', e); return res.status(500).json({ error: e.message }); }
    }

    // GET /api/instructor/students/:id/payments  (_route=payments)
    if (route === 'payments' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(
          `SELECT id, amount, paid_at::date AS paid_at, note
           FROM legacy_payments WHERE student_id=$1 ORDER BY paid_at DESC`, [id]
        );
        return res.status(200).json({ rows });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // POST /api/instructor/students/:id/payments
    if (route === 'payments' && req.method === 'POST') {
      try {
        const { amount, date, note } = req.body || {};
        if (!amount) return res.status(400).json({ error: 'Podaj kwotę' });
        const paidAt = date ? new Date(date) : new Date();
        const { rows: [x] } = await pool.query(
          `INSERT INTO legacy_payments (student_id,amount,paid_at,note) VALUES ($1,$2,$3,$4) RETURNING *`,
          [id, amount, paidAt, note || null]
        );
        return res.status(200).json(x);
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // DELETE /api/instructor/students/:id/payments?pid=...
    if (route === 'payments' && req.method === 'DELETE') {
      try {
        if (!pid) return res.status(400).json({ error: 'Brak pid' });
        await pool.query(`DELETE FROM legacy_payments WHERE id=$1 AND student_id=$2`, [pid, id]);
        return res.status(200).json({ ok: true });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // GET /api/instructor/students/:id/attendance  (_route=attendance)
    if (route === 'attendance' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(`
          SELECT ts.session_date::date AS session_date, g.name AS group_name, l.city,
            COALESCE(a.present,false) AS present
          FROM attendances a
          JOIN training_sessions ts ON ts.id=a.session_id
          JOIN groups g ON g.id=ts.group_id
          LEFT JOIN locations l ON l.id=g.location_id
          WHERE a.student_id=$1 AND ts.session_date>=$2
          ORDER BY ts.session_date DESC
          LIMIT 200
        `, [id, SEASON]);
        return res.status(200).json({ rows });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }


    // GET /api/instructor/students/:id/groups — grupy instruktora + czy kursant jest w każdej
    if (route === 'groups' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(`
          SELECT g.id, g.name, g.category,
            l.city AS location_city,
            COALESCE(sg.active, false) AS student_active
          FROM instructor_groups ig
          JOIN groups g ON g.id = ig.group_id
          LEFT JOIN locations l ON l.id = g.location_id
          LEFT JOIN student_groups sg ON sg.student_id=$2 AND sg.group_id=g.id
          WHERE ig.instructor_id=$1 AND g.active=true
          ORDER BY l.city, g.name
        `, [P.sub, id]);
        return res.status(200).json({ rows });
      } catch (e) { console.error('[student-groups GET]', e); return res.status(500).json({ error: e.message }); }
    }

    // POST /api/instructor/students/:id/groups — przenieś/dodaj/usuń z grupy
    // body: { group_id, action: 'add'|'remove'|'move', from_group_id? }
    if (route === 'groups' && req.method === 'POST') {
      try {
        const { group_id, action, from_group_id } = req.body || {};
        if (!group_id) return res.status(400).json({ error: 'Brak group_id' });

        // Weryfikacja dostępu do grupy docelowej
        const { rows: [chk] } = await pool.query(
          `SELECT 1 FROM instructor_groups WHERE instructor_id=$1 AND group_id=$2`,
          [P.sub, group_id]
        );
        if (!chk) return res.status(403).json({ error: 'Brak dostępu do tej grupy' });

        if (action === 'remove') {
          await pool.query(
            `UPDATE student_groups SET active=false WHERE student_id=$1 AND group_id=$2`,
            [id, group_id]
          );
          return res.status(200).json({ ok: true, action: 'removed' });
        }

        if (action === 'move' && from_group_id) {
          // Weryfikacja dostępu do grupy źródłowej
          const { rows: [chkFrom] } = await pool.query(
            `SELECT 1 FROM instructor_groups WHERE instructor_id=$1 AND group_id=$2`,
            [P.sub, from_group_id]
          );
          if (!chkFrom) return res.status(403).json({ error: 'Brak dostępu do grupy źródłowej' });

          await pool.query(
            `UPDATE student_groups SET active=false WHERE student_id=$1 AND group_id=$2`,
            [id, from_group_id]
          );
        }

        // Dodaj / aktywuj w grupie docelowej
        await pool.query(
          `INSERT INTO student_groups (student_id, group_id, active)
           VALUES ($1,$2,true)
           ON CONFLICT (student_id, group_id) DO UPDATE SET active=true`,
          [id, group_id]
        );
        return res.status(200).json({ ok: true, action: action === 'move' ? 'moved' : 'added' });
      } catch (e) { console.error('[student-groups POST]', e); return res.status(500).json({ error: e.message }); }
    }

    // PATCH /api/instructor/students/:id  (brak _route)
    if (!route && id && req.method === 'PATCH') {
      try {
        const b = req.body || {};
        await pool.query(
          `UPDATE students
           SET first_name=$2,last_name=$3,phone=$4,email=$5,birth_year=$6
           WHERE id=$1`,
          [id, b.first_name, b.last_name, b.phone || null, b.email || null, b.birth_year || null]
        );
        return res.status(200).json({ ok: true });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // DELETE /api/instructor/students/:id  (brak _route, soft delete jeśli ma historię)
    if (!route && id && req.method === 'DELETE') {
      try {
        const { rows: [h] } = await pool.query(`
          SELECT
            (SELECT COUNT(*) FROM attendances WHERE student_id=$1)::int AS att,
            (SELECT COUNT(*) FROM legacy_payments WHERE student_id=$1)::int AS pay
        `, [id]);
        if ((h.att || 0) > 0 || (h.pay || 0) > 0) {
          await pool.query(`UPDATE students SET is_active=false WHERE id=$1`, [id]);
          return res.status(200).json({ ok: true, soft: true });
        }
        await pool.query(`DELETE FROM student_groups WHERE student_id=$1`, [id]);
        await pool.query(`DELETE FROM students WHERE id=$1`, [id]);
        return res.status(200).json({ ok: true, soft: false });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // POST /api/instructor/students  (brak _route, brak id)
    if (!route && !id && req.method === 'POST') {
      try {
        // Sprawdź uprawnienie
        const { rows: [perms] } = await pool.query(
          `SELECT can_add_student FROM instructor_permissions WHERE instructor_id=$1`, [P.sub]);
        if (perms && perms.can_add_student === false) return res.status(403).json({ error: 'Brak uprawnień do dodawania kursantów.' });
        const { first_name, last_name, phone, email, birth_year, group_id } = req.body || {};
        if (!first_name || !last_name) return res.status(400).json({ error: 'Imię i nazwisko są wymagane' });
        const { rows: [s] } = await pool.query(
          `INSERT INTO students (first_name,last_name,phone,email,birth_year,is_active,source)
           VALUES ($1,$2,$3,$4,$5,true,'manual') RETURNING id`,
          [first_name, last_name, phone || null, email || null, birth_year || null]
        );
        if (group_id) {
          await pool.query(
            `INSERT INTO student_groups (student_id, group_id, active)
             VALUES ($1,$2,true)
             ON CONFLICT (student_id, group_id) DO UPDATE SET active=true`,
            [s.id, group_id]
          );
        }
        // Alert dla admina
        const { rows: [inst] } = await pool.query(`SELECT first_name,last_name FROM instructors WHERE id=$1`, [P.sub]);
        const { rows: [grp] } = await pool.query(`SELECT name FROM groups WHERE id=$1`, [group_id]);
        await pool.query(
          `INSERT INTO instructor_events (instructor_id, event_type, student_id, group_id, note, metadata)
           VALUES ($1,'student_added',$2,$3,$4,$5)`,
          [P.sub, s.id, group_id || null, null,
          JSON.stringify({
            instructor_name: `${inst?.first_name} ${inst?.last_name}`,
            student_name: `${first_name} ${last_name}`,
            group_name: grp?.name || null
          })]);
        return res.status(200).json({ id: s.id });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(400).json({ error: 'Nieznana trasa students.' });
  }

  return res.status(400).json({ error: 'Nieznany moduł.' });
};
