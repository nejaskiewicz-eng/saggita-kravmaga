// api/admin-api/registrations/[id].js  — Funkcja #8
// GET    /api/admin-api/registrations        → lista (z filtrowaniem)
// GET    /api/admin-api/registrations/:id    → szczegóły
// PATCH  /api/admin-api/registrations/:id    → edycja
// DELETE /api/admin-api/registrations/:id    → usunięcie
// POST   /api/admin-api/registrations        → nowy zapis (z admina)
const { getPool } = require('../../_lib/db');
const { requireAuth } = require('../../_lib/auth');

const ALLOWED_PATCH = [
  'first_name','last_name','email','phone','birth_year','is_new',
  'group_id','schedule_id','price_plan_id','location_id',
  'start_date','preferred_time','is_waitlist',
  'status','payment_status','payment_method','total_amount',
  'paid_at','admin_notes',
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const id = req.query.id; // może być undefined dla listy

  // ── GET lista ──────────────────────────────────────────────────
  if (req.method === 'GET' && !id) {
    try {
      const { source, status, payment_status, q, page = 1, limit = 30 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);
      const where = ['1=1'];
      const vals = [];
      let pi = 1;
      if (source)         { where.push(`r.source=$${pi++}`); vals.push(source); }
      if (status)         { where.push(`r.status=$${pi++}`); vals.push(status); }
      if (payment_status) { where.push(`r.payment_status=$${pi++}`); vals.push(payment_status); }
      if (q) {
        where.push(`(r.first_name ILIKE $${pi} OR r.last_name ILIKE $${pi} OR r.email ILIKE $${pi} OR r.payment_ref ILIKE $${pi})`);
        vals.push(`%${q}%`); pi++;
      }

      const sql = `
        SELECT r.id, r.first_name, r.last_name, r.email, r.phone,
               r.status, r.payment_status, r.is_waitlist, r.source,
               r.payment_ref, r.total_amount, r.created_at,
               g.name AS group_name, l.city
        FROM registrations r
        LEFT JOIN groups g ON g.id = r.group_id
        LEFT JOIN locations l ON l.id = r.location_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC
        LIMIT $${pi} OFFSET $${pi+1}`;
      vals.push(parseInt(limit), offset);

      const countSql = `
        SELECT COUNT(*)::int AS total FROM registrations r
        LEFT JOIN groups g ON g.id = r.group_id
        LEFT JOIN locations l ON l.id = r.location_id
        WHERE ${where.join(' AND ')}`;

      const [{ rows }, { rows: [ct] }] = await Promise.all([
        pool.query(sql, vals),
        pool.query(countSql, vals.slice(0, -2)),
      ]);

      return res.status(200).json({ rows, total: ct.total, page: parseInt(page), limit: parseInt(limit) });
    } catch (e) {
      console.error('[registrations GET list]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET szczegóły ──────────────────────────────────────────────
  if (req.method === 'GET' && id) {
    try {
      const { rows: [r] } = await pool.query(`
        SELECT r.*,
               g.name AS group_name, g.category,
               l.city, l.name AS location_name,
               pp.name AS plan_name,
               s.day_of_week AS schedule_day, s.time_start AS schedule_time_start,
               s.time_end AS schedule_time_end
        FROM registrations r
        LEFT JOIN groups g ON g.id = r.group_id
        LEFT JOIN locations l ON l.id = r.location_id
        LEFT JOIN price_plans pp ON pp.id = r.price_plan_id
        LEFT JOIN schedules s ON s.id = r.schedule_id
        WHERE r.id = $1`, [id]);
      if (!r) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json(r);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST nowy zapis z admina ───────────────────────────────────
  if (req.method === 'POST') {
    try {
      const b = req.body || {};
      if (!b.first_name || !b.last_name) return res.status(400).json({ error: 'Imię i nazwisko są wymagane.' });

      function genRef() {
        const ts = Date.now().toString(36).toUpperCase();
        const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
        return `KM-${ts}-${rnd}`;
      }

      const { rows: [reg] } = await pool.query(`
        INSERT INTO registrations (
          first_name, last_name, email, phone, birth_year, is_new,
          group_id, schedule_id, price_plan_id, location_id,
          start_date, preferred_time, is_waitlist,
          status, payment_status, payment_method,
          payment_ref, total_amount, source, admin_notes
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'admin',$19)
        RETURNING id, payment_ref`,
        [
          b.first_name, b.last_name, b.email||null, b.phone||null,
          b.birth_year||null, b.is_new!==false,
          b.group_id||null, b.schedule_id||null, b.price_plan_id||null, b.location_id||null,
          b.start_date||null, b.preferred_time||null, b.is_waitlist||false,
          b.status||'confirmed', b.payment_status||'unpaid', b.payment_method||'transfer',
          genRef(), b.total_amount||0, b.admin_notes||null,
        ]
      );
      return res.status(201).json(reg);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH edycja ───────────────────────────────────────────────
  if (req.method === 'PATCH' && id) {
    try {
      const b = req.body || {};
      const set = [];
      const vals = [];
      let pi = 1;
      for (const key of ALLOWED_PATCH) {
        if (key in b) { set.push(`${key}=$${pi++}`); vals.push(b[key]); }
      }
      if (!set.length) return res.status(400).json({ error: 'Brak pól do aktualizacji' });
      set.push(`updated_at=NOW()`);
      vals.push(id);
      const { rowCount } = await pool.query(
        `UPDATE registrations SET ${set.join(',')} WHERE id=$${pi}`, vals
      );
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ─────────────────────────────────────────────────────
  if (req.method === 'DELETE' && id) {
    try {
      const { rowCount } = await pool.query(`DELETE FROM registrations WHERE id=$1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
