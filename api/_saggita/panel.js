// api/_saggita/panel.js — Panel Instruktora
// Obsługuje: instructor-auth, instructor-panel, instructor-attendance,
//            instructor-students, instructor-calendar
// ZERO nowych funkcji Vercel — routowane przez api/saggita.js

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
    (pad ? b + '='.repeat(4-pad) : b).replace(/-/g,'+').replace(/_/g,'/'), 'base64'
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
          SELECT g.id, g.name, g.category, g.age_range, g.notes,
            l.id AS location_id, l.city AS location_city, l.name AS location_name,
            COUNT(DISTINCT sg.student_id) FILTER (WHERE sg.active=true)::int AS student_count,
            COALESCE(json_agg(
              json_build_object('id',s.id,'day_of_week',s.day_of_week,'day_name',s.day_name,
                'time_start',s.time_start,'time_end',s.time_end,'time_label',s.time_label)
              ORDER BY s.day_of_week, s.time_start
            ) FILTER (WHERE s.id IS NOT NULL), '[]') AS schedules
          FROM groups g
          LEFT JOIN locations l     ON l.id=g.location_id
          LEFT JOIN student_groups sg ON sg.group_id=g.id
          LEFT JOIN schedules s     ON s.group_id=g.id AND s.active=true
          WHERE g.active=true
          GROUP BY g.id, l.id
          ORDER BY l.city, g.name
        `);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // GET /api/instructor/groups/:id/students
    if (route === 'students' && id && req.method === 'GET') {
      try {
        const { rows } = await pool.query(`
          SELECT s.id, s.first_name, s.last_name, s.email, s.phone, s.birth_year, s.is_active,
            (SELECT MAX(lp.paid_at) FROM legacy_payments lp WHERE lp.student_id=s.id)::date AS last_payment,
            (SELECT SUM(lp.amount) FROM legacy_payments lp WHERE lp.student_id=s.id AND lp.paid_at>=$2)::numeric AS paid_season,
            (SELECT COUNT(*) FROM attendances a JOIN training_sessions ts ON ts.id=a.session_id
             WHERE a.student_id=s.id AND ts.session_date>=$2 AND a.present=true)::int AS att_season
          FROM students s
          JOIN student_groups sg ON sg.student_id=s.id AND sg.group_id=$1 AND sg.active=true
          ORDER BY s.last_name, s.first_name
        `, [id, SEASON]);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // GET /api/instructor/payments
    if (route === 'payments' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(`
          SELECT lp.id, lp.amount, lp.paid_at::date AS paid_at, lp.note,
            s.id AS student_id, s.first_name, s.last_name,
            g.name AS group_name, l.city AS location_city
          FROM legacy_payments lp
          JOIN students s ON s.id=lp.student_id
          LEFT JOIN student_groups sg ON sg.student_id=s.id AND sg.active=true
          LEFT JOIN groups g ON g.id=sg.group_id
          LEFT JOIN locations l ON l.id=g.location_id
          WHERE lp.paid_at>=$1
          ORDER BY lp.paid_at DESC LIMIT 300
        `, [SEASON]);
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
            FROM training_sessions ts
            LEFT JOIN groups g ON g.id=ts.group_id
            LEFT JOIN locations l ON l.id=g.location_id
            LEFT JOIN attendances a ON a.session_id=ts.id
            WHERE ts.session_date>=$1`;
          const p=[from||SEASON]; let pi=2;
          if (to)       { q+=` AND ts.session_date<=$${pi++}`; p.push(to); }
          if (group_id) { q+=` AND ts.group_id=$${pi++}`;     p.push(group_id); }
          q+=' GROUP BY ts.id,g.id,l.id ORDER BY ts.session_date DESC LIMIT 400';
          const { rows } = await pool.query(q, p);
          return res.status(200).json({ rows });
        } catch(e) { return res.status(500).json({ error:e.message }); }
      }

      if (req.method === 'POST') {
        try {
          const { group_id, session_date } = req.body || {};
          if (!group_id || !session_date)
            return res.status(400).json({ error: 'Brak group_id lub session_date.' });
          const { rows:[sess] } = await pool.query(`
            INSERT INTO training_sessions (group_id, session_date)
            VALUES ($1,$2)
            ON CONFLICT (group_id, session_date) DO UPDATE SET group_id=EXCLUDED.group_id
            RETURNING *
          `, [group_id, session_date]);
          return res.status(201).json(sess);
        } catch(e) { return res.status(500).json({ error:e.message }); }
      }
    }

    if (route === 'attendance' && id) {
      if (req.method === 'GET') {
        try {
          const { rows } = await pool.query(`
            SELECT s.id AS student_id, s.first_name, s.last_name,
              a.id AS attendance_id, a.present,
              (SELECT MAX(lp.paid_at) FROM legacy_payments lp WHERE lp.student_id=s.id)::date AS last_payment
            FROM student_groups sg
            JOIN training_sessions ts ON ts.id=$1
            JOIN students s ON s.id=sg.student_id AND s.is_active=true
            LEFT JOIN attendances a ON a.session_id=$1 AND a.student_id=s.id
            WHERE sg.group_id=ts.group_id AND sg.active=true
            ORDER BY s.last_name, s.first_name
          `, [id]);
          return res.status(200).json({ rows });
        } catch(e) { return res.status(500).json({ error:e.message }); }
      }

      if (req.method === 'POST') {
        try {
          const { student_id, present } = req.body || {};
          if (!student_id) return res.status(400).json({ error: 'Brak student_id.' });
          await pool.query(`
            INSERT INTO attendances (session_id,student_id,present)
            VALUES ($1,$2,$3)
            ON CONFLICT (session_id,student_id) DO UPDATE SET present=EXCLUDED.present
          `, [parseInt(id), parseInt(student_id), !!present]);
          return res.status(200).json({ success:true });
        } catch(e) { return res.status(500).json({ error:e.message }); }
      }
    }

    return res.status(400).json({ error: 'Nieznana trasa attendance.' });
  }

  /* ══ STUDENTS: CRUD + płatności + obecności ══════════════════ */
  if (mod === 'instructor-students') {
    try { auth(req); } catch(e) { return res.status(401).json({ error:e.message }); }

    // płatności
    if (id && route === 'payments') {
      if (req.method === 'GET') {
        try {
          const { rows } = await pool.query(
            `SELECT id,amount,paid_at::date AS paid_at,note
             FROM legacy_payments WHERE student_id=$1 ORDER BY paid_at DESC`, [id]);
          return res.status(200).json({ rows });
        } catch(e) { return res.status(500).json({ error:e.message }); }
      }
      if (req.method === 'POST') {
        const { amount, date, note } = req.body || {};
        if (!amount) return res.status(400).json({ error: 'Kwota wymagana.' });
        try {
          const { rows:[p] } = await pool.query(
            `INSERT INTO legacy_payments (student_id,amount,paid_at,note) VALUES ($1,$2,$3,$4) RETURNING *`,
            [id, parseFloat(amount), date||new Date().toISOString().slice(0,10), note||null]);
          return res.status(201).json(p);
        } catch(e) { return res.status(500).json({ error:e.message }); }
      }
      if (req.method === 'DELETE' && pid) {
        try {
          await pool.query(`DELETE FROM legacy_payments WHERE id=$1 AND student_id=$2`, [pid, id]);
          return res.status(200).json({ success:true });
        } catch(e) { return res.status(500).json({ error:e.message }); }
      }
    }

    // obecności kursanta
    if (id && route === 'attendance' && req.method === 'GET') {
      try {
        const { rows } = await pool.query(`
          SELECT a.id, a.present, ts.session_date, ts.id AS session_id, g.name AS group_name
          FROM attendances a
          JOIN training_sessions ts ON ts.id=a.session_id
          LEFT JOIN groups g ON g.id=ts.group_id
          WHERE a.student_id=$1 AND ts.session_date>=$2
          ORDER BY ts.session_date DESC LIMIT 100
        `, [id, SEASON]);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // GET szczegóły
    if (id && req.method === 'GET') {
      try {
        const { rows:[s] } = await pool.query(`
          SELECT s.*,
            COALESCE((
              SELECT json_agg(json_build_object('id',g.id,'name',g.name,'active',sg.active))
              FROM student_groups sg JOIN groups g ON g.id=sg.group_id WHERE sg.student_id=s.id
            ),'[]') AS groups,
            (SELECT MAX(lp.paid_at) FROM legacy_payments lp WHERE lp.student_id=s.id)::date AS last_payment,
            (SELECT SUM(lp.amount) FROM legacy_payments lp WHERE lp.student_id=s.id AND lp.paid_at>=$2)::numeric AS paid_season,
            (SELECT COUNT(*) FROM attendances a
             JOIN training_sessions ts ON ts.id=a.session_id
             WHERE a.student_id=s.id AND ts.session_date>=$2 AND a.present=true)::int AS att_season
          FROM students s WHERE s.id=$1
        `, [id, SEASON]);
        if (!s) return res.status(404).json({ error: 'Nie znaleziono.' });
        return res.status(200).json(s);
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // POST nowy kursant
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.first_name||!b.last_name)
        return res.status(400).json({ error: 'Imię i nazwisko są wymagane.' });
      try {
        const { rows:[s] } = await pool.query(`
          INSERT INTO students (first_name,last_name,email,phone,birth_year,is_active,source)
          VALUES ($1,$2,$3,$4,$5,true,'instructor') RETURNING *
        `, [b.first_name.trim(),b.last_name.trim(),b.email||null,b.phone||null,b.birth_year||null]);
        if (b.group_id)
          await pool.query(`INSERT INTO student_groups (student_id,group_id,active) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [s.id, b.group_id]);
        return res.status(201).json(s);
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // PATCH edycja
    if (id && req.method === 'PATCH') {
      const b = req.body||{};
      const set=[],vals=[]; let pi=1;
      for (const k of ['first_name','last_name','email','phone','birth_year','is_active']) {
        if (k in b) { set.push(`${k}=$${pi++}`); vals.push(b[k]); }
      }
      if (!set.length) return res.status(400).json({ error: 'Brak pól.' });
      vals.push(id);
      try {
        await pool.query(`UPDATE students SET ${set.join(',')} WHERE id=$${pi}`, vals);
        return res.status(200).json({ success:true });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    // DELETE kursant
    if (id && req.method === 'DELETE') {
      try {
        const { rows:[x] } = await pool.query(`
          SELECT (SELECT COUNT(*) FROM attendances WHERE student_id=$1)::int AS att,
                 (SELECT COUNT(*) FROM legacy_payments WHERE student_id=$1)::int AS pay
        `, [id]);
        if ((x?.att||0)>0||(x?.pay||0)>0) {
          await pool.query(`UPDATE students SET is_active=false WHERE id=$1`, [id]);
          return res.status(200).json({ success:true, soft:true });
        }
        await pool.query(`DELETE FROM student_groups WHERE student_id=$1`, [id]);
        await pool.query(`DELETE FROM students WHERE id=$1`, [id]);
        return res.status(200).json({ success:true, soft:false });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    return res.status(405).end();
  }

  /* ══ CALENDAR ════════════════════════════════════════════════ */
  if (mod === 'instructor-calendar') {
    try { auth(req); } catch(e) { return res.status(401).json({ error:e.message }); }

    if (req.method === 'GET') {
      try {
        const { group_id } = req.query;
        const yearEnd = new Date().getFullYear() + '-12-31';
        let q = `
          SELECT ts.id AS session_id, ts.session_date::date AS session_date, ts.group_id,
            g.name AS group_name, l.city AS location_city,
            COUNT(a.id) FILTER (WHERE a.present=true)::int AS present_count,
            COUNT(a.id)::int AS total_marked
          FROM training_sessions ts
          LEFT JOIN groups g ON g.id=ts.group_id
          LEFT JOIN locations l ON l.id=g.location_id
          LEFT JOIN attendances a ON a.session_id=ts.id
          WHERE ts.session_date BETWEEN $1 AND $2`;
        const p=[SEASON, yearEnd]; let pi=3;
        if (group_id) { q+=` AND ts.group_id=$${pi++}`; p.push(group_id); }
        q+=' GROUP BY ts.id,g.id,l.id ORDER BY ts.session_date';
        const { rows } = await pool.query(q, p);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }
    return res.status(405).end();
  }

  return res.status(404).json({ error: 'Nieznany moduł: ' + mod });
};
