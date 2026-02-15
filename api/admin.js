// ════════════════════════════════════════════════════════════════
//  Krav Maga Saggita — ADMIN API
//  POST /admin-api/login             → logowanie
//  POST /admin-api/setup             → pierwsza konfiguracja (tylko raz)
//  GET  /admin-api/stats             → dashboard stats
//  GET  /admin-api/registrations     → lista z filtrami
//  GET  /admin-api/registration/:id  → szczegóły
//  PATCH /admin-api/registration/:id → zmień status / notatki
//  GET  /admin-api/export            → CSV export
// ════════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

const SECRET = process.env.JWT_SECRET || 'km-saggita-secret-CHANGE-IN-NETLIFY-ENV';

// ── Lightweight JWT (no extra deps) ──────────────────────────────
function signToken(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({
    ...payload,
    iat: Date.now(),
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24h
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${sig}`;
}

function verifyToken(token) {
  try {
    const [h, b, sig] = (token || '').split('.');
    const expected = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url');
    if (sig !== expected) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

function getToken(event) {
  return (event.headers?.authorization || event.headers?.Authorization || '').replace('Bearer ', '').trim();
}

// ── Response helpers ──────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Content-Type': 'application/json',
};
const ok  = (body, s = 200) => ({ statusCode: s, headers: CORS, body: JSON.stringify(body) });
const err = (msg,  s = 400) => ({ statusCode: s, headers: CORS, body: JSON.stringify({ error: msg }) });
const unauth = () => err('Brak autoryzacji. Zaloguj się ponownie.', 401);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const raw = event.path
    .replace('/.netlify/functions/admin', '')
    .replace('/admin-api', '')
    .replace(/\/$/, '') || '/';

  const method = event.httpMethod;

  try {
    // ── POST /login ──────────────────────────────────────────────
    if (raw === '/login' && method === 'POST') {
      const { username, password } = JSON.parse(event.body || '{}');
      if (!username || !password) return err('Podaj login i hasło');

      const { rows } = await pool.query(
        'SELECT * FROM admin_users WHERE username = $1', [username.trim()]
      );
      if (!rows.length) return err('Nieprawidłowe dane logowania', 401);

      const valid = await bcrypt.compare(password, rows[0].password_hash);
      if (!valid) return err('Nieprawidłowe dane logowania', 401);

      const token = signToken({ id: rows[0].id, username: rows[0].username });
      return ok({ token, username: rows[0].username });
    }

    // ── POST /setup (tylko gdy brak adminów) ─────────────────────
    if (raw === '/setup' && method === 'POST') {
      const { rows: [{ cnt }] } = await pool.query('SELECT COUNT(*) AS cnt FROM admin_users');
      if (parseInt(cnt) > 0) return err('Konto admina już istnieje. Użyj /login.', 403);

      const { username, password } = JSON.parse(event.body || '{}');
      if (!username?.trim() || !password || password.length < 8)
        return err('Username i hasło (min. 8 znaków) są wymagane');

      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
        [username.trim(), hash]
      );
      return ok({ success: true, message: 'Konto admina utworzone. Możesz się zalogować.' }, 201);
    }

    // ── AUTH GUARD ───────────────────────────────────────────────
    const payload = verifyToken(getToken(event));
    if (!payload) return unauth();

    // ── GET /stats ───────────────────────────────────────────────
    if (raw === '/stats' && method === 'GET') {
      const [{ rows: [totals] }, { rows: byLoc }, { rows: recent }, { rows: byGroup }] = await Promise.all([
        pool.query('SELECT * FROM v_stats'),
        pool.query(`
          SELECT l.city, l.slug, l.id AS loc_id,
            COUNT(r.id)                                          AS total,
            COUNT(r.id) FILTER (WHERE r.payment_status = 'paid') AS paid,
            COUNT(r.id) FILTER (WHERE r.status = 'new')          AS pending,
            COUNT(r.id) FILTER (WHERE r.is_waitlist = true)      AS waitlist
          FROM locations l
          LEFT JOIN groups g ON g.location_id = l.id
          LEFT JOIN registrations r ON r.group_id = g.id AND r.status != 'cancelled'
          GROUP BY l.id, l.city, l.slug
          ORDER BY l.id
        `),
        pool.query(`
          SELECT r.id, r.first_name || ' ' || r.last_name AS name,
                 r.email, r.payment_status, r.status, r.created_at,
                 l.city, g.name AS group_name
          FROM registrations r
          LEFT JOIN groups g ON r.group_id = g.id
          LEFT JOIN locations l ON g.location_id = l.id
          ORDER BY r.created_at DESC LIMIT 8
        `),
        pool.query(`
          SELECT g.name, l.city, g.max_capacity,
            COUNT(r.id) FILTER (WHERE r.status != 'cancelled' AND r.is_waitlist = false) AS registered
          FROM groups g
          LEFT JOIN locations l ON g.location_id = l.id
          LEFT JOIN registrations r ON r.group_id = g.id
          WHERE g.active = true
          GROUP BY g.id, g.name, l.city, g.max_capacity
          ORDER BY l.id, g.id
        `),
      ]);

      return ok({ ...totals, byLoc, recent, byGroup });
    }

    // ── GET /registrations ───────────────────────────────────────
    if (raw === '/registrations' && method === 'GET') {
      const q = event.queryStringParameters || {};
      const where = ['1=1'];
      const params = [];
      let pi = 1;

      if (q.status)         { where.push(`r.status = $${pi++}`);         params.push(q.status); }
      if (q.payment_status) { where.push(`r.payment_status = $${pi++}`); params.push(q.payment_status); }
      if (q.location)       { where.push(`l.slug = $${pi++}`);           params.push(q.location); }
      if (q.category)       { where.push(`g.category = $${pi++}`);       params.push(q.category); }
      if (q.waitlist === 'true')  where.push('r.is_waitlist = true');
      if (q.waitlist === 'false') where.push('r.is_waitlist = false');
      if (q.search) {
        where.push(`(r.first_name ILIKE $${pi} OR r.last_name ILIKE $${pi} OR r.email ILIKE $${pi} OR r.payment_ref ILIKE $${pi} OR r.phone ILIKE $${pi})`);
        params.push(`%${q.search}%`); pi++;
      }

      const limit  = Math.min(parseInt(q.limit)  || 50, 200);
      const offset = parseInt(q.offset) || 0;
      const orderBy = q.sort === 'amount' ? 'r.total_amount DESC' : 'r.created_at DESC';

      const whereStr = where.join(' AND ');
      const [{ rows }, { rows: [{ total }] }] = await Promise.all([
        pool.query(`
          SELECT
            r.id, r.created_at, r.first_name, r.last_name,
            r.email, r.phone, r.payment_ref,
            r.payment_status, r.status, r.total_amount,
            r.is_waitlist, r.is_new, r.start_date,
            g.name AS group_name, g.category,
            l.city, l.slug AS location_slug,
            p.name AS plan_name
          FROM registrations r
          LEFT JOIN groups g   ON r.group_id      = g.id
          LEFT JOIN locations l ON g.location_id  = l.id
          LEFT JOIN price_plans p ON r.price_plan_id = p.id
          WHERE ${whereStr}
          ORDER BY ${orderBy}
          LIMIT ${limit} OFFSET ${offset}
        `, params),
        pool.query(`
          SELECT COUNT(*) AS total
          FROM registrations r
          LEFT JOIN groups g    ON r.group_id     = g.id
          LEFT JOIN locations l ON g.location_id  = l.id
          WHERE ${whereStr}
        `, params),
      ]);

      return ok({ rows, total: parseInt(total), limit, offset });
    }

    // ── GET /registration/:id ────────────────────────────────────
    if (raw.match(/^\/registration\/\d+$/) && method === 'GET') {
      const id = raw.split('/')[2];
      const { rows: [reg] } = await pool.query(
        'SELECT * FROM v_registrations WHERE id = $1', [id]
      );
      if (!reg) return err('Nie znaleziono zapisu', 404);
      return ok(reg);
    }

    // ── PATCH /registration/:id ──────────────────────────────────
    if (raw.match(/^\/registration\/\d+$/) && method === 'PATCH') {
      const id = raw.split('/')[2];
      const updates = JSON.parse(event.body || '{}');

      const ALLOWED = ['status', 'payment_status', 'admin_notes', 'is_waitlist', 'start_date'];
      const set = [];
      const vals = [];
      let pi = 1;

      for (const key of ALLOWED) {
        if (key in updates) {
          set.push(`${key} = $${pi++}`);
          vals.push(updates[key]);
        }
      }
      // Auto-set paid_at
      if (updates.payment_status === 'paid') {
        set.push('paid_at = NOW()');
      }

      if (!set.length) return err('Brak pól do aktualizacji');

      vals.push(id);
      await pool.query(
        `UPDATE registrations SET ${set.join(', ')} WHERE id = $${pi}`,
        vals
      );

      return ok({ success: true });
    }

    // ── GET /export ──────────────────────────────────────────────
    if (raw === '/export' && method === 'GET') {
      const { rows } = await pool.query(`
        SELECT
          r.id, r.created_at, r.first_name, r.last_name,
          r.email, r.phone, r.birth_year,
          CASE WHEN r.is_new THEN 'nowy' ELSE 'kontynuacja' END AS typ,
          l.city AS lokalizacja, g.name AS grupa, g.category AS kategoria,
          r.start_date AS data_startu,
          p.name AS karnet,
          r.total_amount AS kwota,
          r.payment_method AS metoda,
          r.payment_status AS status_platnosci,
          r.payment_ref AS kod_ref,
          r.paid_at AS data_zaplaty,
          r.status AS status_zapisu,
          CASE WHEN r.is_waitlist THEN 'tak' ELSE 'nie' END AS lista_rezerwowa,
          r.admin_notes AS notatki_admina
        FROM registrations r
        LEFT JOIN groups g    ON r.group_id      = g.id
        LEFT JOIN locations l ON g.location_id   = l.id
        LEFT JOIN price_plans p ON r.price_plan_id = p.id
        ORDER BY r.created_at DESC
        LIMIT 5000
      `);

      if (!rows.length) {
        return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'text/csv' }, body: 'Brak danych' };
      }

      const keys = Object.keys(rows[0]);
      const csvRows = [
        keys.join(';'),
        ...rows.map(r =>
          keys.map(k => {
            const v = r[k];
            if (v === null || v === undefined) return '';
            if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
            const s = String(v).replace(/"/g, '""');
            return /[;\n"]/.test(s) ? `"${s}"` : s;
          }).join(';')
        ),
      ].join('\r\n');

      const date = new Date().toISOString().slice(0, 10);
      return {
        statusCode: 200,
        headers: {
          ...CORS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="km-zapisy-${date}.csv"`,
        },
        body: '\uFEFF' + csvRows, // BOM for Excel
      };
    }

    return err('Nie znaleziono ścieżki', 404);

  } catch (e) {
    console.error('[ADMIN]', e);
    return err('Błąd serwera: ' + e.message, 500);
  }
};
