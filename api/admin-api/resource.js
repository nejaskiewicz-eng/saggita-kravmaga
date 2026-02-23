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
          ORDER BY i.last_name, i.first_name
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
        await pool.query(`UPDATE instructors SET active=false WHERE id=$1`, [id]);
        return res.status(200).json({ success: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(405).json({ error: 'Method not allowed' });
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
