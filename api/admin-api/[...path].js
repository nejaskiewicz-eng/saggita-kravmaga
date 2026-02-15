// api/admin-api/[...path].js
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getPool } = require("../_db");

const SECRET = process.env.JWT_SECRET;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
}

function signToken(payload) {
  if (!SECRET) throw new Error("Brak JWT_SECRET w ENV");
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const b = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 24 * 60 * 60 * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url");
  return `${h}.${b}.${sig}`;
}

function verifyToken(token) {
  try {
    if (!SECRET) return null;
    const [h, b, sig] = (token || "").split(".");
    if (!h || !b || !sig) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url");
    if (sig !== expected) return null;
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    if (p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

function getToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  return String(auth).replace(/^Bearer\s+/i, "").trim();
}

function unauth(res) { return res.status(401).json({ error: "Brak autoryzacji. Zaloguj się ponownie." }); }
function bad(res, msg, code = 400) { return res.status(code).json({ error: msg }); }

async function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body || "{}"); } catch { return {}; } }
  try {
    const raw = await new Promise((resolve, reject) => {
      let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(d)); req.on("error", reject);
    });
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function resolveRawPath(req) {
  const qp = req.query?.path;
  const arr = Array.isArray(qp) ? qp : qp ? [qp] : null;
  if (arr && arr.length) return "/" + arr.join("/");
  try {
    const full = new URL(req.url, "https://local");
    const pathname = full.pathname || "";
    const prefix = "/api/admin-api";
    if (pathname.startsWith(prefix)) {
      const rest = pathname.slice(prefix.length) || "/";
      return rest.startsWith("/") ? rest : "/" + rest;
    }
    return pathname || "/";
  } catch { return "/"; }
}

function toInt(v, fallback) { const x = parseInt(String(v ?? ""), 10); return Number.isFinite(x) ? x : fallback; }

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const pool = getPool();
  const raw = resolveRawPath(req);
  const method = req.method;

  try {
    // ─── GET /status (public) ──────────────────────────────────────────────
    if (raw === "/status" && method === "GET") {
      const [{ rows: [{ now }] }, { rows: [{ cnt }] }] = await Promise.all([
        pool.query("SELECT NOW()::text AS now"),
        pool.query("SELECT COUNT(*)::int AS cnt FROM admin_users"),
      ]);
      return res.status(200).json({ ok: true, server_time: now, admin_users: cnt, note: cnt > 0 ? "Admin istnieje → użyj /login." : "Brak admina → zrób /setup (POST)." });
    }

    // ─── POST /setup (public) ──────────────────────────────────────────────
    if (raw === "/setup" && method === "POST") {
      const { rows: [{ cnt }] } = await pool.query("SELECT COUNT(*)::int AS cnt FROM admin_users");
      if (parseInt(cnt, 10) > 0) return bad(res, "Konto admina już istnieje. Użyj /login.", 403);
      const { username, password } = await getBody(req);
      if (!String(username || "").trim() || !password || String(password).length < 8) return bad(res, "Username i hasło (min. 8 znaków) są wymagane");
      const hash = await bcrypt.hash(String(password), 12);
      await pool.query("INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)", [String(username).trim(), hash]);
      return res.status(201).json({ success: true, message: "Konto admina utworzone." });
    }

    // ─── POST /login (public) ──────────────────────────────────────────────
    if (raw === "/login" && method === "POST") {
      const { username, password } = await getBody(req);
      if (!username || !password) return bad(res, "Podaj login i hasło");
      const { rows } = await pool.query("SELECT * FROM admin_users WHERE username = $1", [String(username).trim()]);
      if (!rows.length) return bad(res, "Nieprawidłowe dane logowania", 401);
      const valid = await bcrypt.compare(String(password), rows[0].password_hash);
      if (!valid) return bad(res, "Nieprawidłowe dane logowania", 401);
      const token = signToken({ id: rows[0].id, username: rows[0].username });
      return res.status(200).json({ token, username: rows[0].username });
    }

    // ─── AUTH GUARD ────────────────────────────────────────────────────────
    const payload = verifyToken(getToken(req));
    if (!payload) return unauth(res);

    // ══════════════════════════════════════════════════════════════════════
    // STATS
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/stats" && method === "GET") {
      const [{ rows: [totals] }, { rows: byLoc }, { rows: recent }, { rows: byGroup }] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid,
            COUNT(*) FILTER (WHERE status = 'new')::int AS pending,
            COUNT(*) FILTER (WHERE is_waitlist = true)::int AS waitlist
          FROM registrations WHERE status != 'cancelled'
        `),
        pool.query(`
          SELECT l.id AS loc_id, l.city, l.slug,
            COUNT(r.id)::int AS total,
            COUNT(r.id) FILTER (WHERE r.payment_status = 'paid')::int AS paid,
            COUNT(r.id) FILTER (WHERE r.status = 'new')::int AS pending,
            COUNT(r.id) FILTER (WHERE r.is_waitlist = true)::int AS waitlist
          FROM locations l
          LEFT JOIN groups g ON g.location_id = l.id
          LEFT JOIN registrations r ON r.group_id = g.id AND r.status != 'cancelled'
          GROUP BY l.id, l.city, l.slug ORDER BY l.id
        `),
        pool.query(`
          SELECT r.id, r.first_name || ' ' || r.last_name AS name,
                 r.email, r.payment_status, r.status, r.created_at,
                 r.source, l.city, g.name AS group_name
          FROM registrations r
          LEFT JOIN groups g ON r.group_id = g.id
          LEFT JOIN locations l ON g.location_id = l.id
          ORDER BY r.created_at DESC LIMIT 8
        `),
        pool.query(`
          SELECT g.id, g.name, l.city, g.max_capacity,
            COUNT(r.id) FILTER (WHERE r.status != 'cancelled' AND r.is_waitlist = false)::int AS registered
          FROM groups g
          LEFT JOIN locations l ON g.location_id = l.id
          LEFT JOIN registrations r ON r.group_id = g.id
          WHERE g.active = true
          GROUP BY g.id, g.name, l.city, g.max_capacity ORDER BY l.city, g.id
        `),
      ]);
      return res.status(200).json({ ...(totals || {}), byLoc, recent, byGroup });
    }

    // ══════════════════════════════════════════════════════════════════════
    // REGISTRATIONS — lista
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/registrations" && method === "GET") {
      const q = req.query || {};
      const where = ["1=1"];
      const params = [];
      let pi = 1;

      if (q.status)         { where.push(`r.status = $${pi++}`); params.push(q.status); }
      if (q.payment_status) { where.push(`r.payment_status = $${pi++}`); params.push(q.payment_status); }
      if (q.location)       { where.push(`l.slug = $${pi++}`); params.push(q.location); }
      if (q.category)       { where.push(`g.category = $${pi++}`); params.push(q.category); }
      if (q.source)         { where.push(`r.source = $${pi++}`); params.push(q.source); }
      if (q.waitlist === "true")  where.push("r.is_waitlist = true");
      if (q.waitlist === "false") where.push("r.is_waitlist = false");
      if (q.search) {
        where.push(`(r.first_name ILIKE $${pi} OR r.last_name ILIKE $${pi} OR r.email ILIKE $${pi} OR r.payment_ref ILIKE $${pi} OR r.phone ILIKE $${pi})`);
        params.push(`%${q.search}%`); pi++;
      }

      const limit   = Math.min(toInt(q.limit, 50), 200);
      const offset  = Math.max(toInt(q.offset, 0), 0);
      const orderBy = q.sort === "amount" ? "r.total_amount DESC" : "r.created_at DESC";
      const whereStr = where.join(" AND ");

      const [{ rows }, { rows: [{ total }] }] = await Promise.all([
        pool.query(`
          SELECT r.id, r.created_at, r.first_name, r.last_name, r.email, r.phone,
                 r.payment_ref, r.payment_status, r.status, r.total_amount,
                 r.is_waitlist, r.is_new, r.start_date, r.source,
                 g.name AS group_name, g.category,
                 l.city, l.slug AS location_slug,
                 p.name AS plan_name
          FROM registrations r
          LEFT JOIN groups g ON r.group_id = g.id
          LEFT JOIN locations l ON g.location_id = l.id
          LEFT JOIN price_plans p ON r.price_plan_id = p.id
          WHERE ${whereStr} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}
        `, params),
        pool.query(`
          SELECT COUNT(*)::int AS total FROM registrations r
          LEFT JOIN groups g ON r.group_id = g.id
          LEFT JOIN locations l ON g.location_id = l.id
          WHERE ${whereStr}
        `, params),
      ]);
      return res.status(200).json({ rows, total: parseInt(total, 10), limit, offset });
    }

    // ══════════════════════════════════════════════════════════════════════
    // REGISTRATION — pojedynczy zapis GET
    // ══════════════════════════════════════════════════════════════════════
    if (raw.match(/^\/registration\/\d+$/) && method === "GET") {
      const id = raw.split("/")[2];
      const { rows: [reg] } = await pool.query(`
        SELECT r.*,
               g.name AS group_name, g.category, g.max_capacity,
               l.city, l.slug AS location_slug, l.name AS location_name,
               p.name AS plan_name
        FROM registrations r
        LEFT JOIN groups g ON r.group_id = g.id
        LEFT JOIN locations l ON g.location_id = l.id
        LEFT JOIN price_plans p ON r.price_plan_id = p.id
        WHERE r.id = $1
      `, [id]);
      if (!reg) return bad(res, "Nie znaleziono zapisu", 404);
      return res.status(200).json(reg);
    }

    // ══════════════════════════════════════════════════════════════════════
    // REGISTRATION — edycja PATCH (rozszerzona)
    // ══════════════════════════════════════════════════════════════════════
    if (raw.match(/^\/registration\/\d+$/) && method === "PATCH") {
      const id = raw.split("/")[2];
      const updates = await getBody(req);

      const ALLOWED = [
        "status", "payment_status", "admin_notes", "is_waitlist", "start_date",
        "first_name", "last_name", "email", "phone", "birth_year",
        "group_id", "price_plan_id", "payment_method", "total_amount",
        "is_new", "preferred_time", "source"
      ];
      const set = [];
      const vals = [];
      let pi = 1;

      for (const key of ALLOWED) {
        if (key in updates) { set.push(`${key} = $${pi++}`); vals.push(updates[key]); }
      }
      if (updates.payment_status === "paid" && !("paid_at" in updates)) set.push("paid_at = NOW()");
      if (!set.length) return bad(res, "Brak pól do aktualizacji");

      vals.push(id);
      await pool.query(`UPDATE registrations SET ${set.join(", ")} WHERE id = $${pi}`, vals);
      return res.status(200).json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════
    // REGISTRATION — usuwanie DELETE
    // ══════════════════════════════════════════════════════════════════════
    if (raw.match(/^\/registration\/\d+$/) && method === "DELETE") {
      const id = raw.split("/")[2];
      const { rowCount } = await pool.query("DELETE FROM registrations WHERE id = $1", [id]);
      if (!rowCount) return bad(res, "Nie znaleziono zapisu", 404);
      return res.status(200).json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════
    // PARTICIPANT — dodaj nowego kursanta (admin)
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/participant" && method === "POST") {
      const b = await getBody(req);
      const required = ["first_name", "last_name", "group_id"];
      for (const f of required) {
        if (!b[f]) return bad(res, `Pole ${f} jest wymagane`);
      }

      const { rows: [reg] } = await pool.query(`
        INSERT INTO registrations (
          group_id, schedule_id, price_plan_id,
          first_name, last_name, email, phone, birth_year,
          is_new, start_date, payment_method, total_amount,
          payment_status, status, is_waitlist,
          preferred_time, consent_data, consent_rules,
          admin_notes, source
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15,
          $16, $17, $18,
          $19, 'admin'
        ) RETURNING id, first_name, last_name
      `, [
        b.group_id,
        b.schedule_id || null,
        b.price_plan_id || null,
        b.first_name,
        b.last_name,
        b.email || null,
        b.phone || null,
        b.birth_year || null,
        b.is_new !== undefined ? b.is_new : true,
        b.start_date || null,
        b.payment_method || 'cash',
        b.total_amount || 0,
        b.payment_status || 'unpaid',
        b.status || 'confirmed',
        b.is_waitlist || false,
        b.preferred_time || null,
        true,
        true,
        b.admin_notes || null,
      ]);
      return res.status(201).json({ success: true, id: reg.id, name: reg.first_name + " " + reg.last_name });
    }

    // ══════════════════════════════════════════════════════════════════════
    // GROUPS — lista
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/groups" && method === "GET") {
      const { rows } = await pool.query(`
        SELECT g.*,
               l.city, l.name AS location_name, l.slug AS location_slug,
               COUNT(r.id) FILTER (WHERE r.status != 'cancelled' AND r.is_waitlist = false)::int AS registered_count,
               COUNT(r.id) FILTER (WHERE r.is_waitlist = true)::int AS waitlist_count
        FROM groups g
        LEFT JOIN locations l ON g.location_id = l.id
        LEFT JOIN registrations r ON r.group_id = g.id
        GROUP BY g.id, l.id, l.city, l.name, l.slug
        ORDER BY l.city, g.category, g.name
      `);
      return res.status(200).json({ rows });
    }

    // ══════════════════════════════════════════════════════════════════════
    // GROUP — dodaj
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/groups" && method === "POST") {
      const b = await getBody(req);
      if (!b.name || !b.location_id) return bad(res, "Pola name i location_id są wymagane");
      const { rows: [g] } = await pool.query(`
        INSERT INTO groups (location_id, name, category, age_range, max_capacity, active, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
      `, [b.location_id, b.name, b.category || 'adults', b.age_range || null, b.max_capacity || 20, b.active !== false, b.notes || null]);
      return res.status(201).json({ success: true, id: g.id });
    }

    // ══════════════════════════════════════════════════════════════════════
    // GROUP — edycja PATCH
    // ══════════════════════════════════════════════════════════════════════
    // GROUPS — podgląd jednej grupy
    if (raw.match(/^\/groups\/\d+$/) && method === "GET") {
      const id = raw.split("/")[2];
      const { rows: [g] } = await pool.query(`
        SELECT
          g.*,
          l.city,
          l.name AS location_name,
          l.slug AS location_slug,
          COUNT(r.id) FILTER (WHERE r.status != 'cancelled' AND r.is_waitlist = false)::int AS registered_count,
          COUNT(r.id) FILTER (WHERE r.status != 'cancelled' AND r.is_waitlist = true)::int  AS waitlist_count
        FROM groups g
        LEFT JOIN locations l ON l.id = g.location_id
        LEFT JOIN registrations r ON r.group_id = g.id
        WHERE g.id = $1
        GROUP BY g.id, l.id
      `, [id]);
      if (!g) return bad(res, "Nie znaleziono grupy", 404);
      return res.status(200).json(g);
    }

    if (raw.match(/^\/groups\/\d+$/) && method === "PATCH") {
      const id = raw.split("/")[2];
      const b = await getBody(req);
      const ALLOWED = ["name", "category", "age_range", "max_capacity", "active", "notes", "location_id"];
      const set = []; const vals = []; let pi = 1;
      for (const key of ALLOWED) { if (key in b) { set.push(`${key} = $${pi++}`); vals.push(b[key]); } }
      if (!set.length) return bad(res, "Brak pól do aktualizacji");
      vals.push(id);
      await pool.query(`UPDATE groups SET ${set.join(", ")} WHERE id = $${pi}`, vals);
      return res.status(200).json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════
    // GROUP — usuń DELETE
    // ══════════════════════════════════════════════════════════════════════
    if (raw.match(/^\/groups\/\d+$/) && method === "DELETE") {
      const id = raw.split("/")[2];
      const { rows: [{ cnt }] } = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM registrations WHERE group_id = $1 AND status != 'cancelled'", [id]
      );
      if (parseInt(cnt) > 0) return bad(res, `Nie można usunąć — grupa ma ${cnt} aktywnych zapisów.`, 409);
      await pool.query("DELETE FROM schedules WHERE group_id = $1", [id]);
      const { rowCount } = await pool.query("DELETE FROM groups WHERE id = $1", [id]);
      if (!rowCount) return bad(res, "Nie znaleziono grupy", 404);
      return res.status(200).json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════
    // SCHEDULES — lista
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/schedules" && method === "GET") {
      const { rows } = await pool.query(`
        SELECT s.*, g.name AS group_name, g.category, l.city, l.slug AS location_slug
        FROM schedules s
        LEFT JOIN groups g ON s.group_id = g.id
        LEFT JOIN locations l ON g.location_id = l.id
        ORDER BY l.city, s.day_of_week, s.time_start
      `);
      return res.status(200).json({ rows });
    }

    // ══════════════════════════════════════════════════════════════════════
    // SCHEDULE — dodaj
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/schedules" && method === "POST") {
      const b = await getBody(req);
      if (!b.group_id || b.day_of_week === undefined) return bad(res, "Pola group_id i day_of_week są wymagane");
      const { rows: [s] } = await pool.query(`
        INSERT INTO schedules (group_id, day_of_week, time_start, time_end, address, active)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
      `, [b.group_id, b.day_of_week, b.time_start || null, b.time_end || null, b.address || null, b.active !== false]);
      return res.status(201).json({ success: true, id: s.id });
    }

    // ══════════════════════════════════════════════════════════════════════
    // SCHEDULE — edycja PATCH
    // ══════════════════════════════════════════════════════════════════════
    if (raw.match(/^\/schedules\/\d+$/) && method === "PATCH") {
      const id = raw.split("/")[2];
      const b = await getBody(req);
      const ALLOWED = ["group_id", "day_of_week", "time_start", "time_end", "address", "active"];
      const set = []; const vals = []; let pi = 1;
      for (const key of ALLOWED) { if (key in b) { set.push(`${key} = $${pi++}`); vals.push(b[key]); } }
      if (!set.length) return bad(res, "Brak pól do aktualizacji");
      vals.push(id);
      await pool.query(`UPDATE schedules SET ${set.join(", ")} WHERE id = $${pi}`, vals);
      return res.status(200).json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════
    // SCHEDULE — usuń DELETE
    // ══════════════════════════════════════════════════════════════════════
    if (raw.match(/^\/schedules\/\d+$/) && method === "DELETE") {
      const id = raw.split("/")[2];
      await pool.query("UPDATE registrations SET schedule_id = NULL WHERE schedule_id = $1", [id]);
      const { rowCount } = await pool.query("DELETE FROM schedules WHERE id = $1", [id]);
      if (!rowCount) return bad(res, "Nie znaleziono terminu", 404);
      return res.status(200).json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════
    // LOCATIONS — lista
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/locations" && method === "GET") {
      const { rows } = await pool.query(`
        SELECT l.*,
          COUNT(DISTINCT g.id)::int AS groups_count,
          COUNT(r.id) FILTER (WHERE r.status != 'cancelled')::int AS registrations_count
        FROM locations l
        LEFT JOIN groups g ON g.location_id = l.id
        LEFT JOIN registrations r ON r.group_id = g.id
        GROUP BY l.id ORDER BY l.city
      `);
      return res.status(200).json({ rows });
    }

    // ══════════════════════════════════════════════════════════════════════
    // LOCATION — dodaj
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/locations" && method === "POST") {
      const b = await getBody(req);
      if (!b.name || !b.city || !b.slug) return bad(res, "Pola name, city i slug są wymagane");
      const { rows: [l] } = await pool.query(`
        INSERT INTO locations (slug, name, city, address, venue, active)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
      `, [b.slug, b.name, b.city, b.address || null, b.venue || null, b.active !== false]);
      return res.status(201).json({ success: true, id: l.id });
    }

    // ══════════════════════════════════════════════════════════════════════
    // LOCATION — edycja PATCH
    // ══════════════════════════════════════════════════════════════════════
    if (raw.match(/^\/locations\/\d+$/) && method === "PATCH") {
      const id = raw.split("/")[2];
      const b = await getBody(req);
      const ALLOWED = ["slug", "name", "city", "address", "venue", "active"];
      const set = []; const vals = []; let pi = 1;
      for (const key of ALLOWED) { if (key in b) { set.push(`${key} = $${pi++}`); vals.push(b[key]); } }
      if (!set.length) return bad(res, "Brak pól do aktualizacji");
      vals.push(id);
      await pool.query(`UPDATE locations SET ${set.join(", ")} WHERE id = $${pi}`, vals);
      return res.status(200).json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════
    // PRICE PLANS — lista
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/plans" && method === "GET") {
      const { rows } = await pool.query(`SELECT * FROM price_plans ORDER BY sort_order, category, months`);
      return res.status(200).json({ rows });
    }

    // ══════════════════════════════════════════════════════════════════════
    // EXPORT CSV
    // ══════════════════════════════════════════════════════════════════════
    if (raw === "/export" && method === "GET") {
      const { rows } = await pool.query(`
        SELECT
          r.id, r.created_at, r.first_name, r.last_name,
          r.email, r.phone, r.birth_year,
          CASE WHEN r.is_new THEN 'nowy' ELSE 'kontynuacja' END AS typ,
          COALESCE(r.source, 'web') AS źródło,
          l.city AS lokalizacja, g.name AS grupa, g.category AS kategoria,
          r.start_date AS data_startu, p.name AS karnet,
          r.total_amount AS kwota, r.payment_method AS metoda,
          r.payment_status AS status_platnosci, r.payment_ref AS kod_ref,
          r.paid_at AS data_zaplaty, r.status AS status_zapisu,
          CASE WHEN r.is_waitlist THEN 'tak' ELSE 'nie' END AS lista_rezerwowa,
          r.admin_notes AS notatki_admina
        FROM registrations r
        LEFT JOIN groups g ON r.group_id = g.id
        LEFT JOIN locations l ON g.location_id = l.id
        LEFT JOIN price_plans p ON r.price_plan_id = p.id
        ORDER BY r.created_at DESC LIMIT 5000
      `);

      if (!rows.length) { res.setHeader("Content-Type", "text/csv; charset=utf-8"); return res.status(200).send("Brak danych"); }
      const keys = Object.keys(rows[0]);
      const csvRows = [
        keys.join(";"),
        ...rows.map(r => keys.map(k => {
          const v = r[k];
          if (v === null || v === undefined) return "";
          if (v instanceof Date) return v.toISOString().replace("T", " ").slice(0, 19);
          const s = String(v).replace(/"/g, '""');
          return /[;\n"]/.test(s) ? `"${s}"` : s;
        }).join(";"))
      ].join("\r\n");

      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="km-zapisy-${date}.csv"`);
      return res.status(200).send("\uFEFF" + csvRows);
    }

    return bad(res, "Nie znaleziono ścieżki", 404);
  } catch (e) {
    console.error("[ADMIN]", raw, method, e);
    return res.status(500).json({ error: "Błąd serwera: " + e.message });
  }
};
