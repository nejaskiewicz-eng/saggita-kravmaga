// ════════════════════════════════════════════════════════════════
//  Krav Maga Saggita — PUBLIC API
//  GET  /api/schedule        → grafik (lokalizacje + grupy + terminy)
//  GET  /api/prices          → cennik
//  POST /api/register        → złóż zapis
//  GET  /api/status/:ref     → sprawdź status zapisu
// ════════════════════════════════════════════════════════════════

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function ok(body, status = 200) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(body) };
}
function err(msg, status = 400) {
  return { statusCode: status, headers: CORS, body: JSON.stringify({ error: msg }) };
}

// Kod referencyjny przelewu: KM-XXXXXX
function genRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'KM';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const DAY_PL = ['', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota', 'Niedziela'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // Strip function prefix from path
  const raw = event.path
    .replace('/.netlify/functions/api', '')
    .replace('/api', '')
    .replace(/\/$/, '') || '/';

  const method = event.httpMethod;

  try {
    // ── GET /schedule ────────────────────────────────────────────
    if (raw === '/schedule' && method === 'GET') {
      const [{ rows: locs }, { rows: grps }, { rows: scheds }, { rows: cnts }] = await Promise.all([
        pool.query('SELECT * FROM locations WHERE active = true ORDER BY id'),
        pool.query('SELECT * FROM groups WHERE active = true ORDER BY location_id, id'),
        pool.query('SELECT * FROM schedules WHERE active = true ORDER BY group_id, day_of_week NULLS LAST, time_start'),
        pool.query(`
          SELECT group_id, COUNT(*) AS cnt
          FROM registrations
          WHERE status NOT IN ('cancelled') AND is_waitlist = false
          GROUP BY group_id
        `),
      ]);

      const cntMap = {};
      cnts.forEach(c => { cntMap[c.group_id] = parseInt(c.cnt); });

      const data = locs.map(loc => ({
        ...loc,
        groups: grps
          .filter(g => g.location_id === loc.id)
          .map(g => ({
            ...g,
            registered: cntMap[g.id] || 0,
            available: Math.max(0, g.max_capacity - (cntMap[g.id] || 0)),
            schedules: scheds
              .filter(s => s.group_id === g.id)
              .map(s => ({
                ...s,
                day_name: s.day_of_week ? DAY_PL[s.day_of_week] : null,
                time_label: s.time_start && s.time_end
                  ? `${String(s.time_start).slice(0,5)} – ${String(s.time_end).slice(0,5)}`
                  : null,
              })),
          })),
      }));

      return ok(data);
    }

    // ── GET /prices ──────────────────────────────────────────────
    if (raw === '/prices' && method === 'GET') {
      const { rows } = await pool.query(
        'SELECT * FROM price_plans WHERE active = true ORDER BY sort_order'
      );
      return ok(rows);
    }

    // ── POST /register ───────────────────────────────────────────
    if (raw === '/register' && method === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return err('Nieprawidłowy format danych'); }

      const {
        first_name, last_name, email, phone,
        birth_year, is_new = true,
        group_id, schedule_id, price_plan_id,
        start_date, payment_method = 'transfer',
        consent_data, consent_rules,
        preferred_time, is_waitlist = false,
      } = body;

      // Walidacja
      if (!first_name?.trim() || !last_name?.trim()) return err('Podaj imię i nazwisko');
      if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Podaj prawidłowy adres email');
      if (!phone?.trim()) return err('Podaj numer telefonu');
      if (!consent_data || !consent_rules) return err('Wymagana zgoda na przetwarzanie danych i akceptacja regulaminu');

      // Pobierz cennik i oblicz kwotę
      let total_amount = null;
      let plan = null;
      if (price_plan_id) {
        const { rows: [p] } = await pool.query(
          'SELECT * FROM price_plans WHERE id = $1 AND active = true', [price_plan_id]
        );
        if (p) {
          plan = p;
          total_amount = parseFloat(p.price) + (is_new ? parseFloat(p.signup_fee || 0) : 0);
        }
      }

      // Sprawdź czy lista rezerwowa
      let finalWaitlist = is_waitlist;
      if (group_id && !finalWaitlist) {
        const { rows: [grp] } = await pool.query(
          'SELECT max_capacity, notes FROM groups WHERE id = $1', [group_id]
        );
        if (grp?.notes?.toLowerCase().includes('zamknięty')) {
          finalWaitlist = true;
        } else if (grp) {
          const { rows: [{ cnt }] } = await pool.query(
            "SELECT COUNT(*) AS cnt FROM registrations WHERE group_id = $1 AND status NOT IN ('cancelled') AND is_waitlist = false",
            [group_id]
          );
          if (parseInt(cnt) >= grp.max_capacity) finalWaitlist = true;
        }
      }

      // Generuj unikalny kod ref
      let ref;
      for (let i = 0; i < 10; i++) {
        ref = genRef();
        const { rows } = await pool.query(
          'SELECT id FROM registrations WHERE payment_ref = $1', [ref]
        );
        if (!rows.length) break;
      }

      const { rows: [reg] } = await pool.query(`
        INSERT INTO registrations (
          first_name, last_name, email, phone, birth_year, is_new,
          group_id, schedule_id, price_plan_id, start_date,
          payment_method, total_amount, payment_ref,
          consent_data, consent_rules, is_waitlist, preferred_time,
          status
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13,
          $14,$15,$16,$17,
          $18
        )
        RETURNING id, payment_ref, total_amount, is_waitlist, status
      `, [
        first_name.trim(), last_name.trim(), email.trim().toLowerCase(), phone.trim(),
        birth_year || null, Boolean(is_new),
        group_id || null, schedule_id || null, price_plan_id || null,
        start_date || null,
        payment_method, total_amount, ref,
        Boolean(consent_data), Boolean(consent_rules),
        finalWaitlist, preferred_time || null,
        finalWaitlist ? 'waitlist' : 'new',
      ]);

      return ok({
        success: true,
        id: reg.id,
        payment_ref: reg.payment_ref,
        total_amount: reg.total_amount,
        is_waitlist: reg.is_waitlist,
        status: reg.status,
        // Dane do przelewu
        bank_account: '21 1140 2004 0000 3902 3890 8895',
        bank_name: 'AKADEMIA OBRONY SAGGITA',
        transfer_title: `Krav Maga ${first_name.trim()} ${last_name.trim()} ${reg.payment_ref}`,
        address: 'Pl. Św. Małgorzaty 1-2, 58-100 Świdnica',
        phone: '510 930 460',
        email_contact: 'biuro@akademiaobrony.pl',
      }, 201);
    }

    // ── GET /status/:ref ─────────────────────────────────────────
    if (raw.startsWith('/status/') && method === 'GET') {
      const ref = raw.replace('/status/', '').trim().toUpperCase();
      const { rows: [reg] } = await pool.query(`
        SELECT r.id, r.first_name, r.last_name, r.payment_ref,
               r.payment_status, r.status, r.total_amount,
               r.is_waitlist, r.created_at, r.start_date,
               g.name AS group_name, l.city, l.address AS location_address,
               p.name AS plan_name
        FROM registrations r
        LEFT JOIN groups g ON r.group_id = g.id
        LEFT JOIN locations l ON g.location_id = l.id
        LEFT JOIN price_plans p ON r.price_plan_id = p.id
        WHERE r.payment_ref = $1
      `, [ref]);

      if (!reg) return err('Nie znaleziono zapisu o podanym kodzie', 404);
      return ok(reg);
    }

    return err('Nie znaleziono ścieżki', 404);

  } catch (e) {
    console.error('[API]', e);
    return err('Błąd serwera. Spróbuj ponownie za chwilę.', 500);
  }
};
