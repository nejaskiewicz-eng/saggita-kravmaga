// api/admin-api/resource.js
// Obsługuje: groups (GET single/PATCH/DELETE), schedules, locations, instructors (pełny CRUD)
const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const bcrypt = require('bcryptjs');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const { type, id } = req.query;

  // ── INSTRUKTORZY ──────────────────────────────────────────────
  if (type === 'instructors') {

    if (req.method === 'GET' && !id) {
      try {
        const { rows } = await pool.query(`
          SELECT i.id, i.username, i.first_name, i.last_name, i.email, i.phone, i.active, i.created_at,
            COALESCE(json_agg(
              json_build_object('id', g.id, 'name', g.name)
            ) FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
          FROM instructors i
          LEFT JOIN instructor_groups ig ON ig.instructor_id = i.id
          LEFT JOIN groups g ON g.id = ig.group_id
          GROUP BY i.id
          ORDER BY i.active DESC, i.last_name, i.first_name
        `);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'GET' && id) {
      try {
        const { rows: [inst] } = await pool.query(`
          SELECT i.id, i.username, i.first_name, i.last_name, i.email, i.phone, i.active,
            COALESCE(json_agg(
              json_build_object('id', g.id, 'name', g.name)
            ) FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
          FROM instructors i
          LEFT JOIN instructor_groups ig ON ig.instructor_id = i.id
          LEFT JOIN groups g ON g.id = ig.group_id
          WHERE i.id = $1
          GROUP BY i.id
        `, [id]);
        if (!inst) return res.status(404).json({ error: 'Nie znaleziono.' });
        return res.status(200).json(inst);
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.username || !b.password || !b.first_name || !b.last_name)
        return res.status(400).json({ error: 'username, password, first_name, last_name są wymagane.' });
      if (b.password.length < 8)
        return res.status(400).json({ error: 'Hasło musi mieć co najmniej 8 znaków.' });
      try {
        const hash = await bcrypt.hash(b.password, 12);
        const { rows: [inst] } = await pool.query(`
          INSERT INTO instructors (username, password_hash, first_name, last_name, email, phone, active)
          VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id, username, first_name, last_name
        `, [b.username.trim(), hash, b.first_name.trim(), b.last_name.trim(), b.email||null, b.phone||null]);
        if (Array.isArray(b.group_ids) && b.group_ids.length) {
          for (const gid of b.group_ids) {
            await pool.query(`INSERT INTO instructor_groups (instructor_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [inst.id, gid]);
          }
        }
        return res.status(201).json(inst);
      } catch(e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Login już istnieje.' });
        return res.status(500).json({ error: e.message });
      }
    }

    if (req.method === 'PATCH' && id) {
      const b = req.body || {};
      try {
        const set = [], vals = []; let pi = 1;
        for (const k of ['first_name','last_name','email','phone','active']) {
          if (k in b) { set.push(`${k}=$${pi++}`); vals.push(b[k]); }
        }
        if (b.password) {
          if (b.password.length < 8) return res.status(400).json({ error: 'Hasło musi mieć co najmniej 8 znaków.' });
          const hash = await bcrypt.hash(b.password, 12);
          set.push(`password_hash=$${pi++}`); vals.push(hash);
        }
        if (set.length) {
          vals.push(id);
          await pool.query(`UPDATE instructors SET ${set.join(',')} WHERE id=$${pi}`, vals);
        }
        if (Array.isArray(b.group_ids)) {
          await pool.query(`DELETE FROM instructor_groups WHERE instructor_id=$1`, [id]);
          for (const gid of b.group_ids) {
            await pool.query(`INSERT INTO instructor_groups (instructor_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, gid]);
          }
        }
        return res.status(200).json({ success: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'DELETE' && id) {
      try {
        if (req.query.hard === 'true') {
          // Twarde usunięcie: usuń w kolejności zależności
          await pool.query(`DELETE FROM instructor_events WHERE instructor_id=$1`, [id]);
          await pool.query(`DELETE FROM instructor_students WHERE instructor_id=$1`, [id]);
          await pool.query(`DELETE FROM instructor_permissions WHERE instructor_id=$1`, [id]);
          await pool.query(`DELETE FROM instructor_groups WHERE instructor_id=$1`, [id]);
          await pool.query(`DELETE FROM instructors WHERE id=$1`, [id]);
        } else {
          await pool.query(`UPDATE instructors SET active=false WHERE id=$1`, [id]);
        }
        return res.status(200).json({ success: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── UPRAWNIENIA INSTRUKTORA ───────────────────────────────────
  if (type === 'instructor-permissions') {
    const instId = id || req.body?.instructor_id;

    if (req.method === 'GET' && id) {
      try {
        const { rows:[p] } = await pool.query(
          `SELECT * FROM instructor_permissions WHERE instructor_id=$1`, [id]);
        return res.status(200).json(p || {});
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'PATCH' && id) {
      const b = req.body || {};
      const allowed = ['can_see_groups','can_see_student_count',
                       'can_see_paid_status','can_see_payments','can_see_payments_tab',
                       'can_accept_payment','can_add_student','can_mark_attendance',
                       'can_assign_instructors'];
      try {
        const set = [], vals = []; let pi = 1;
        for (const k of allowed) if (k in b) { set.push(`${k}=$${pi++}`); vals.push(b[k]); }
        if (set.length) {
          vals.push(id);
          await pool.query(
            `INSERT INTO instructor_permissions (instructor_id) VALUES ($1) ON CONFLICT (instructor_id) DO NOTHING`,
            [id]);
          await pool.query(`UPDATE instructor_permissions SET ${set.join(',')}, updated_at=NOW() WHERE instructor_id=$${pi}`, vals);
        }
        return res.status(200).json({ success: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── PRZYPISANIE KURSANTÓW DO INSTRUKTORA ─────────────────────
  if (type === 'instructor-students') {
    if (req.method === 'GET' && id) {
      try {
        // Pobierz kursantów z grup instruktora + zaznacz czy przypisani
        const { rows } = await pool.query(`
          SELECT DISTINCT s.id, s.first_name, s.last_name, s.is_active,
            g.id AS group_id, g.name AS group_name,
            EXISTS(
              SELECT 1 FROM instructor_students ist
              WHERE ist.instructor_id=$1 AND ist.student_id=s.id
            ) AS assigned
          FROM students s
          JOIN student_groups sg ON sg.student_id=s.id AND sg.active=true
          JOIN groups g ON g.id=sg.group_id
          JOIN instructor_groups ig ON ig.group_id=g.id AND ig.instructor_id=$1
          WHERE s.is_active=true
          ORDER BY g.name, s.last_name, s.first_name
        `, [id]);
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'POST' && id) {
      // Zapisz pełną listę przypisanych kursantów (zastąp)
      const { student_ids } = req.body || {};
      if (!Array.isArray(student_ids)) return res.status(400).json({ error: 'student_ids wymagane' });
      try {
        await pool.query(`DELETE FROM instructor_students WHERE instructor_id=$1`, [id]);
        for (const sid of student_ids) {
          await pool.query(
            `INSERT INTO instructor_students (instructor_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, sid]);
        }
        return res.status(200).json({ success: true, count: student_ids.length });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── SESJE TRENINGOWE (admin) ──────────────────────────────────
  if (type === 'sessions') {
    const { group_id, from, to } = req.query;

    if (req.method === 'GET') {
      if (!group_id) return res.status(400).json({ error: 'group_id jest wymagane.' });
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

    if (req.method === 'POST') {
      const { group_id: gid, session_date } = req.body || {};
      if (!gid || !session_date) return res.status(400).json({ error: 'group_id i session_date są wymagane.' });
      try {
        const { rows: [x] } = await pool.query(
          `INSERT INTO training_sessions (group_id, session_date)
           VALUES ($1,$2)
           ON CONFLICT (group_id, session_date) DO UPDATE SET session_date=EXCLUDED.session_date
           RETURNING id`,
          [gid, session_date]);
        return res.status(200).json({ id: x.id });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (req.method === 'DELETE' && id) {
      try {
        await pool.query(`DELETE FROM attendances WHERE session_id=$1`, [id]);
        await pool.query(`DELETE FROM training_sessions WHERE id=$1`, [id]);
        return res.status(200).json({ ok: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── RAPORTY ───────────────────────────────────────────────────
  if (req.query._rep) {
    const rType = req.query.type;   // 'group' | 'instructor'
    const rId   = parseInt(req.query.id);
    const year  = parseInt(req.query.year) || new Date().getFullYear();
    const month = req.query.month ? parseInt(req.query.month) : null;
    if (!rId) return res.status(400).json({ error: 'Brak id.' });

    // Warunek daty
    function dateCond(col, p) {
      if (month) return `EXTRACT(year FROM ${col})=$${p} AND EXTRACT(month FROM ${col})=$${p+1}`;
      return `EXTRACT(year FROM ${col})=$${p}`;
    }
    const dateParams = month ? [year, month] : [year];

    try {
      if (rType === 'group') {
        const [grpRes, sessRes, attRes, payRes] = await Promise.all([
          pool.query(`SELECT g.name, l.city, g.category, g.age_range,
            (SELECT COUNT(*) FROM student_groups sg WHERE sg.group_id=g.id AND sg.active=true)::int AS active_students
            FROM groups g LEFT JOIN locations l ON l.id=g.location_id WHERE g.id=$1`, [rId]),
          pool.query(`SELECT ts.session_date::date AS date,
            COUNT(a.id) FILTER (WHERE a.present=true)::int AS present,
            COUNT(a.id)::int AS total
            FROM training_sessions ts LEFT JOIN attendances a ON a.session_id=ts.id
            WHERE ts.group_id=$1 AND ${dateCond('ts.session_date', 2)}
            GROUP BY ts.id ORDER BY ts.session_date`, [rId, ...dateParams]),
          pool.query(`WITH ps AS (SELECT id FROM training_sessions WHERE group_id=$1 AND ${dateCond('session_date', 2)})
            SELECT s.first_name||' '||s.last_name AS name,
              COUNT(a.id) FILTER (WHERE a.present=true)::int AS present,
              (SELECT COUNT(*) FROM ps)::int AS total_sessions,
              CASE WHEN (SELECT COUNT(*) FROM ps)>0 THEN ROUND(COUNT(a.id) FILTER (WHERE a.present=true)*100.0/(SELECT COUNT(*) FROM ps))::int ELSE NULL END AS pct
            FROM student_groups sg JOIN students s ON s.id=sg.student_id
            LEFT JOIN attendances a ON a.student_id=s.id AND a.session_id IN (SELECT id FROM ps)
            WHERE sg.group_id=$1 AND sg.active=true
            GROUP BY s.id,s.first_name,s.last_name ORDER BY s.last_name,s.first_name`, [rId, ...dateParams]),
          pool.query(`SELECT lp.paid_at::date AS date, s.first_name||' '||s.last_name AS student_name,
            lp.amount, lp.note,
            (SELECT ie.metadata->>'instructor_name' FROM instructor_events ie
              WHERE ie.student_id=lp.student_id AND ie.event_type='payment_accepted'
              AND ie.created_at::date=lp.paid_at::date ORDER BY ie.created_at DESC LIMIT 1) AS accepted_by
            FROM legacy_payments lp JOIN students s ON s.id=lp.student_id
            JOIN student_groups sg ON sg.student_id=s.id AND sg.group_id=$1
            WHERE ${dateCond('lp.paid_at', 2)}
            ORDER BY lp.paid_at DESC`, [rId, ...dateParams]),
        ]);
        const sessions = sessRes.rows;
        const totalSess = sessions.length;
        const totalPresent = sessions.reduce((s,r)=>s+r.present,0);
        const totalSeats = sessions.reduce((s,r)=>s+r.total,0);
        return res.status(200).json({
          period: { year, month },
          group: grpRes.rows[0] || {},
          summary: {
            sessions_count: totalSess,
            total_payments: payRes.rows.reduce((s,p)=>s+Number(p.amount||0),0),
            avg_attendance: totalSeats > 0 ? Math.round(totalPresent/totalSeats*100) : 0
          },
          attendance: attRes.rows,
          payments: payRes.rows,
          sessions: sessions
        });
      }

      if (rType === 'instructor') {
        const [instRes, grpRes, payRes, evRes, sessRes] = await Promise.all([
          pool.query(`SELECT first_name||' '||last_name AS name, email FROM instructors WHERE id=$1`, [rId]),
          pool.query(`SELECT g.name, l.city, COUNT(DISTINCT sg.student_id) FILTER (WHERE sg.active=true)::int AS students
            FROM instructor_groups ig JOIN groups g ON g.id=ig.group_id
            LEFT JOIN locations l ON l.id=g.location_id
            LEFT JOIN student_groups sg ON sg.group_id=g.id
            WHERE ig.instructor_id=$1 GROUP BY g.id,g.name,l.city ORDER BY l.city,g.name`, [rId]),
          pool.query(`SELECT ie.created_at::date AS date, s.first_name||' '||s.last_name AS student_name,
            g.name AS group_name, ie.amount, ie.note
            FROM instructor_events ie LEFT JOIN students s ON s.id=ie.student_id LEFT JOIN groups g ON g.id=ie.group_id
            WHERE ie.instructor_id=$1 AND ie.event_type='payment_accepted' AND ${dateCond('ie.created_at', 2)}
            ORDER BY ie.created_at DESC`, [rId, ...dateParams]),
          pool.query(`SELECT ie.created_at, ie.event_type,
            s.first_name||' '||s.last_name AS student_name, g.name AS group_name, ie.amount
            FROM instructor_events ie LEFT JOIN students s ON s.id=ie.student_id LEFT JOIN groups g ON g.id=ie.group_id
            WHERE ie.instructor_id=$1 AND ${dateCond('ie.created_at', 2)}
            ORDER BY ie.created_at DESC LIMIT 200`, [rId, ...dateParams]),
          pool.query(`SELECT COUNT(*)::int AS cnt FROM training_sessions ts
            JOIN instructor_groups ig ON ig.group_id=ts.group_id AND ig.instructor_id=$1
            WHERE ${dateCond('ts.session_date', 2)}`, [rId, ...dateParams]),
        ]);
        const studAdded = evRes.rows.filter(e=>e.event_type==='student_added').length;
        return res.status(200).json({
          period: { year, month },
          instructor: instRes.rows[0] || {},
          summary: {
            groups_count: grpRes.rows.length,
            sessions_count: sessRes.rows[0]?.cnt || 0,
            total_payments: payRes.rows.reduce((s,p)=>s+Number(p.amount||0),0),
            payments_accepted: payRes.rows.length,
            students_added: studAdded
          },
          groups: grpRes.rows,
          payments: payRes.rows,
          events: evRes.rows
        });
      }

      return res.status(400).json({ error: 'Nieznany typ raportu.' });
    } catch(e) { console.error('[report]', e); return res.status(500).json({ error: e.message }); }
  }

  // ── groups (single), schedules, locations ─────────────────────
  const CONFIG = {
    groups: {
      table: 'groups',
      allowed: ['location_id','name','category','age_range','max_capacity','notes','active'],
      getQuery: `SELECT g.*, l.city FROM groups g LEFT JOIN locations l ON l.id=g.location_id WHERE g.id=$1`
    },
    schedules: {
      table: 'schedules',
      allowed: ['group_id','day_of_week','day_name','time_start','time_end','time_label','address','active'],
      getQuery: `SELECT s.*, g.name AS group_name FROM schedules s LEFT JOIN groups g ON g.id=s.group_id WHERE s.id=$1`
    },
    locations: {
      table: 'locations',
      allowed: ['city','name','slug','address','sort_order','active'],
      getQuery: `SELECT * FROM locations WHERE id=$1`
    }
  };

  if (!CONFIG[type])
    return res.status(400).json({ error: 'Invalid type. Use: groups, schedules, locations, instructors' });

  const { table, allowed, getQuery } = CONFIG[type];

  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(getQuery, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(rows[0]);
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'PATCH') {
    try {
      const b = req.body || {};
      const set = [], vals = []; let pi = 1;
      for (const key of allowed) if (key in b) { set.push(`${key}=$${pi++}`); vals.push(b[key]); }
      if (!set.length) return res.status(400).json({ error: 'No fields to update' });
      vals.push(id);
      const { rowCount } = await pool.query(`UPDATE ${table} SET ${set.join(',')} WHERE id=$${pi}`, vals);
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'DELETE') {
    try {
      const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
