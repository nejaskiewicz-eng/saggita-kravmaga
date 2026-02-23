// api/_saggita/panel.js — Panel Instruktora
// Obsługuje: instructor-auth, instructor-panel, instructor-attendance,
//            instructor-students, instructor-calendar
// ZERO nowych funkcji Vercel — routowane przez api/saggita.js
//
// WAŻNE: odcinamy historię sprzed sezonu po stronie DB poprzez widoki:
// - payments_since_2025_09_01
// - training_sessions_since_2025_09_01

'use strict';
const { getPool } = require('../_lib/db');
const bcrypt      = require('bcryptjs');
const crypto      = require('crypto');

const SEASON = '2025-09-01';

/* ── JWT ──────────────────────────────────────────────────────── */
function b64(o)   { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function makeJWT(p, s) {
  const h = b64({ alg:'HS256', typ:'JWT' });
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
    (pad ? b + '='.repeat(4-pad) : b).replace(/-/g,'+').replace(/_/g,'/'),
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
        const { rows:[i] } = await pool.query(
          `SELECT id,username,password_hash,first_name,last_name,email
           FROM instructors WHERE username=$1 AND active=true`, [username]);
        if (!i) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
        if (!await bcrypt.compare(password, i.password_hash))
          return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
        const secret = process.env.JWT_SECRET;
        if (!secret) throw new Error('Brak JWT_SECRET');
        const token = makeJWT({
          sub:i.id, username:i.username, role:'instructor',
          iat:Math.floor(Date.now()/1000)
        }, secret);
        return res.status(200).json({
          token,
          instructor:{id:i.id, username:i.username, first_name:i.first_name, last_name:i.last_name, email:i.email}
        });
      } catch(e) { console.error('[inst/login]',e); return res.status(500).json({ error:e.message }); }
    }

    if (req.method === 'GET') {
      try {
        const p = auth(req);
        const { rows:[i] } = await pool.query(
          `SELECT id,username,first_name,last_name,email,phone
           FROM instructors WHERE id=$1 AND active=true`, [p.sub]);
        if (!i) return res.status(401).json({ error: 'Brak instruktora.' });
        return res.status(200).json(i);
      } catch(e) { return res.status(401).json({ error:e.message }); }
    }
    return res.status(405).end();
  }

  /* ══ PANEL: grupy, statystyki, płatności ═════════════════════ */
  if (mod === 'instructor-panel') {
    try { auth(req); } catch(e) { return res.status(401).json({ error:e.message }); }

    // GET /api/instructor/groups
    if (route === 'groups' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(`
          SELECT g.id, g.name, g.location_id,
                 l.city AS location_city, l.name AS location_name,
                 (SELECT COUNT(*) FROM student_groups sg WHERE sg.group_id=g.id AND sg.active=true)::int AS student_count,
                 COALESCE((
                   SELECT json_agg(json_build_object(
                     'id', s.id,
                     'day_of_week', s.day_of_week,
                     'day_name', s.day_name,
                     'time_label', s.time_label
                   ) ORDER BY s.day_of_week, s.time_label)
                   FROM schedules s WHERE s.group_id=g.id
                 ), '[]'::json) AS schedules
          FROM groups g
          LEFT JOIN locations l ON l.id=g.location_id
          ORDER BY l.city NULLS LAST, g.name
        `);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // GET /api/instructor/group/:id/students (w praktyce: /api/instructor/groups?id=...)
    if (route === 'group-students' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(`
          SELECT s.id, s.first_name, s.last_name, s.email, s.phone, s.birth_year, s.is_active,
            (SELECT MAX(lp.paid_at) FROM payments_since_2025_09_01 lp WHERE lp.student_id=s.id)::date AS last_payment,
            (SELECT SUM(lp.amount) FROM payments_since_2025_09_01 lp WHERE lp.student_id=s.id AND lp.paid_at>=$2)::numeric AS paid_season,
            (SELECT COUNT(*) FROM attendances a JOIN training_sessions_since_2025_09_01 ts ON ts.id=a.session_id
             WHERE a.student_id=s.id AND ts.session_date>=$2 AND a.present=true)::int AS att_season
          FROM students s
          JOIN student_groups sg ON sg.student_id=s.id AND sg.group_id=$1 AND sg.active=true
          ORDER BY s.last_name, s.first_name
        `, [id, SEASON]);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // GET /api/instructor/payments  (SEZON TYLKO Z WIDOKU)
    if (route === 'payments' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(`
          SELECT lp.id, lp.amount, lp.paid_at::date AS paid_at, lp.note,
            s.id AS student_id, s.first_name, s.last_name,
            g.name AS group_name, l.city AS location_city
          FROM payments_since_2025_09_01 lp
          JOIN students s ON s.id=lp.student_id
          LEFT JOIN student_groups sg ON sg.student_id=s.id AND sg.active=true
          LEFT JOIN groups g ON g.id=sg.group_id
          LEFT JOIN locations l ON l.id=g.location_id
          ORDER BY lp.paid_at DESC LIMIT 300
        `);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    return res.status(400).json({ error: 'Nieznana trasa panel.' });
  }

  /* ══ ATTENDANCE: sesje + obecności ══════════════════════════ */
  if (mod === 'instructor-attendance') {
    try { auth(req); } catch(e) { return res.status(401).json({ error:e.message }); }

    if (route === 'sessions') {
      if (req.method === 'GET') {
        try {
          const { group_id, from, to } = req.query;
          let q = `
            SELECT ts.id AS session_id, ts.session_date::date AS session_date, ts.group_id,
              g.name AS group_name, l.city AS location_city, l.name AS location_name,
              COUNT(a.id) FILTER (WHERE a.present=true)::int AS present_count,
              COUNT(a.id)::int AS total_marked
            FROM training_sessions_since_2025_09_01 ts
            JOIN groups g ON g.id=ts.group_id
            LEFT JOIN locations l ON l.id=g.location_id
            LEFT JOIN attendances a ON a.session_id=ts.id
            WHERE ts.session_date >= $1
          `;
          const params = [from || SEASON];
          if (to) { params.push(to); q += ` AND ts.session_date <= $${params.length}`; }
          if (group_id) { params.push(group_id); q += ` AND ts.group_id = $${params.length}`; }
          q += ` GROUP BY ts.id, g.name, l.city, l.name ORDER BY ts.session_date DESC LIMIT 400`;
          const { rows } = await pool.query(q, params);
          return res.status(200).json({ rows });
        } catch(e) { return res.status(500).json({ error:e.message }); }
      }

      // POST tworzy sesję w PRAWDZIWEJ tabeli training_sessions (nie w widoku)
      if (req.method === 'POST') {
        try {
          const { group_id, session_date } = req.body || {};
          if (!group_id || !session_date) return res.status(400).json({ error:'Brak danych' });
          const { rows:[x] } = await pool.query(
            `INSERT INTO training_sessions (group_id, session_date)
             VALUES ($1,$2)
             ON CONFLICT (group_id, session_date) DO UPDATE SET session_date=EXCLUDED.session_date
             RETURNING id`, [group_id, session_date]
          );
          return res.status(200).json({ id:x.id });
        } catch(e) { return res.status(500).json({ error:e.message }); }
      }
      return res.status(405).end();
    }

    // GET /api/instructor/sessions/:id/attendance
    if (route === 'attendance' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(`
          SELECT s.id AS student_id, s.first_name, s.last_name,
            COALESCE(a.present,false) AS present,
            (SELECT MAX(lp.paid_at) FROM payments_since_2025_09_01 lp WHERE lp.student_id=s.id)::date AS last_payment
          FROM student_groups sg
          JOIN students s ON s.id=sg.student_id
          LEFT JOIN attendances a ON a.session_id=$1 AND a.student_id=s.id
          WHERE sg.group_id=$2 AND sg.active=true
          ORDER BY s.last_name, s.first_name
        `, [id, req.query.group_id]);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // POST /api/instructor/sessions/:id/attendance
    if (route === 'attendance' && req.method === 'POST') {
      try {
        const { student_id, present } = req.body || {};
        if (!student_id) return res.status(400).json({ error:'Brak student_id' });
        await pool.query(`
          INSERT INTO attendances (session_id, student_id, present)
          VALUES ($1,$2,$3)
          ON CONFLICT (session_id, student_id)
          DO UPDATE SET present=EXCLUDED.present
        `, [id, student_id, !!present]);
        return res.status(200).json({ ok:true });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    return res.status(400).json({ error: 'Nieznana trasa attendance.' });
  }

  /* ══ STUDENTS (instruktor) ═══════════════════════════════════ */
  if (mod === 'instructor-students') {
    try { auth(req); } catch(e) { return res.status(401).json({ error:e.message }); }

    // GET /api/instructor/students/:id/payments
    if (route === 'student-payments' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(
          `SELECT id, amount, paid_at, note
           FROM legacy_payments WHERE student_id=$1 ORDER BY paid_at DESC`, [id]
        );
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // POST /api/instructor/students/:id/payments
    if (route === 'student-payments' && req.method === 'POST') {
      try {
        const { amount, date, note } = req.body || {};
        if (!amount) return res.status(400).json({ error:'Podaj kwotę' });
        const paidAt = date ? new Date(date) : new Date();
        const { rows:[x] } = await pool.query(
          `INSERT INTO legacy_payments (student_id,amount,paid_at,note) VALUES ($1,$2,$3,$4) RETURNING *`,
          [id, amount, paidAt, note || null]
        );
        return res.status(200).json(x);
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // DELETE /api/instructor/students/:id/payments?pid=...
    if (route === 'student-payments' && req.method === 'DELETE') {
      try {
        if (!pid) return res.status(400).json({ error:'Brak pid' });
        await pool.query(`DELETE FROM legacy_payments WHERE id=$1 AND student_id=$2`, [pid, id]);
        return res.status(200).json({ ok:true });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // PATCH /api/instructor/students/:id
    if (route === 'student' && req.method === 'PATCH') {
      try {
        const b = req.body || {};
        await pool.query(
          `UPDATE students
           SET first_name=$2,last_name=$3,phone=$4,email=$5,birth_year=$6
           WHERE id=$1`,
          [id, b.first_name, b.last_name, b.phone || null, b.email || null, b.birth_year || null]
        );
        return res.status(200).json({ ok:true });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // DELETE /api/instructor/students/:id  (soft delete jeśli ma historię)
    if (route === 'student' && req.method === 'DELETE') {
      try {
        const { rows:[h] } = await pool.query(`
          SELECT
            (SELECT COUNT(*) FROM attendances WHERE student_id=$1)::int AS att,
            (SELECT COUNT(*) FROM legacy_payments WHERE student_id=$1)::int AS pay
        `, [id]);
        if ((h.att||0) > 0 || (h.pay||0) > 0) {
          await pool.query(`UPDATE students SET is_active=false WHERE id=$1`, [id]);
          return res.status(200).json({ ok:true, soft:true });
        }
        await pool.query(`DELETE FROM students WHERE id=$1`, [id]);
        return res.status(200).json({ ok:true, soft:false });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // POST /api/instructor/students
    if (route === 'students' && req.method === 'POST') {
      try {
        const { first_name, last_name, phone, email, birth_year, group_id } = req.body || {};
        if (!first_name || !last_name) return res.status(400).json({ error:'Imię i nazwisko są wymagane' });
        const { rows:[s] } = await pool.query(
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
        return res.status(200).json({ id:s.id });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    return res.status(400).json({ error:'Nieznana trasa students.' });
  }

  return res.status(400).json({ error:'Nieznany moduł.' });
};
