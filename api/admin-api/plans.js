// api/admin-api/plans.js — obsługuje /plans I /export w jednym pliku (oszczędność limitu Vercel!)
// Routing wewnętrzny przez query param ?_route=export (przekazywany przez vercel.json)
const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

function escapeCSV(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();

  // ── GET plans ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, category, price, signup_fee, months, description, active
         FROM price_plans ORDER BY category, price`
      );
      return res.status(200).json({ rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST nowy plan ────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const b = req.body || {};
      if (!b.name || b.price == null) return res.status(400).json({ error: 'name i price są wymagane.' });
      const { rows: [p] } = await pool.query(
        `INSERT INTO price_plans (name, category, price, signup_fee, months, description, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.name, b.category||'adults', b.price, b.signup_fee||0,
         b.months||null, b.description||null, b.active!==false]
      );
      return res.status(201).json(p);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH edycja planu ────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Brak id.' });
    try {
      const b = req.body || {};
      const ALLOWED = ['name','category','price','signup_fee','months','description','active'];
      const set = [], vals = [];
      let pi = 1;
      for (const key of ALLOWED) {
        if (key in b) { set.push(`${key}=$${pi++}`); vals.push(b[key]); }
      }
      if (!set.length) return res.status(400).json({ error: 'Brak pól.' });
      vals.push(id);
      await pool.query(`UPDATE price_plans SET ${set.join(',')} WHERE id=$${pi}`, vals);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET export CSV (gdy ?_route=export) ──────────────────────
  // Obsługujemy /export w tym samym pliku przez vercel.json rewrite
  return res.status(405).json({ error: 'Method not allowed' });
};

// Export handler — wywoływany bezpośrednio z vercel.json
module.exports.exportCSV = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT r.id, r.first_name, r.last_name, r.email, r.phone,
             r.birth_year, r.is_new, l.city, g.name AS group_name,
             pp.name AS plan_name, r.total_amount, r.payment_ref,
             r.status, r.payment_status, r.payment_method,
             r.is_waitlist, r.source, r.start_date, r.created_at, r.admin_notes
      FROM registrations r
      LEFT JOIN groups g ON g.id = r.group_id
      LEFT JOIN locations l ON l.id = r.location_id
      LEFT JOIN price_plans pp ON pp.id = r.price_plan_id
      ORDER BY r.created_at DESC
    `);

    const headers = ['ID','Imię','Nazwisko','Email','Telefon','Rok urodzenia','Nowy',
      'Miasto','Grupa','Karnet','Kwota','Ref płatności','Status','Status płatności',
      'Metoda płatności','Lista rez.','Źródło','Data startu','Data zapisu','Notatki'];

    const lines = [
      headers.join(','),
      ...rows.map(r => [
        r.id, r.first_name, r.last_name, r.email, r.phone,
        r.birth_year, r.is_new ? 'Tak' : 'Nie', r.city, r.group_name, r.plan_name,
        r.total_amount, r.payment_ref, r.status, r.payment_status, r.payment_method,
        r.is_waitlist ? 'Tak' : 'Nie', r.source,
        r.start_date ? String(r.start_date).slice(0,10) : '',
        r.created_at ? new Date(r.created_at).toLocaleString('pl-PL') : '',
        r.admin_notes
      ].map(escapeCSV).join(','))
    ];

    const csv = '\uFEFF' + lines.join('\r\n');
    const date = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="krav-maga-zapisy-${date}.csv"`);
    return res.status(200).send(csv);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
