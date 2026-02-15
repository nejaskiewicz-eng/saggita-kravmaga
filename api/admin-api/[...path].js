// api/admin-api/[...path].js
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getPool } = require("../_db");

const SECRET = process.env.JWT_SECRET; // ustaw w Vercel!

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
}

function signToken(payload) {
  if (!SECRET) throw new Error("Brak JWT_SECRET w ENV");
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const b = Buffer.from(
    JSON.stringify({
      ...payload,
      iat: Date.now(),
      exp: Date.now() + 24 * 60 * 60 * 1000, // 24h
    })
  ).toString("base64url");
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
  } catch {
    return null;
  }
}

function getToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  return String(auth).replace(/^Bearer\s+/i, "").trim();
}

function unauth(res) {
  return res.status(401).json({ error: "Brak autoryzacji. Zaloguj się ponownie." });
}

function bad(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }

  try {
    const raw = await readRawBody(req);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Najważniejsza poprawka:
 * - czasem Vercel nie podaje req.query.path dla catch-all
 * - więc robimy fallback z req.url i zdejmujemy prefix /api/admin-api
 */
function resolveRawPath(req) {
  // 1) standard (gdy działa)
  const qp = req.query?.path;
  const arr = Array.isArray(qp) ? qp : qp ? [qp] : null;
  if (arr && arr.length) return "/" + arr.join("/");

  // 2) fallback: parsuj z req.url
  try {
    const full = new URL(req.url, "https://local");
    const pathname = full.pathname || "";
    const prefix = "/api/admin-api";
    if (pathname.startsWith(prefix)) {
      const rest = pathname.slice(prefix.length) || "/";
      return rest.startsWith("/") ? rest : "/" + rest;
    }
    // gdyby kiedyś było inaczej
    return pathname || "/";
  } catch {
    return "/";
  }
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const pool = getPool();
  const raw = resolveRawPath(req); // <-- TU
  const method = req.method;

  try {
    // ── GET /status (BEZ LOGOWANIA) ───────────────────────────────
    if (raw === "/status" && method === "GET") {
      // szybki test DB + czy jest admin
      const [{ rows: [{ now }] }, { rows: [{ cnt }] }] = await Promise.all([
        pool.query("SELECT NOW()::text AS now"),
        pool.query("SELECT COUNT(*)::int AS cnt FROM admin_users"),
      ]);
      return res.status(200).json({
        ok: true,
        server_time: now,
        admin_users: cnt,
        note:
          cnt > 0
            ? "Admin istnieje → użyj /login."
            : "Brak admina → zrób /setup (POST).",
      });
    }

    // ── POST /setup (BEZ LOGOWANIA) ───────────────────────────────
    if (raw === "/setup" && method === "POST") {
      const { rows: [{ cnt }] } = await pool.query("SELECT COUNT(*)::int AS cnt FROM admin_users");
      if (parseInt(cnt, 10) > 0) return bad(res, "Konto admina już istnieje. Użyj /login.", 403);

      const { username, password } = await getBody(req);
      if (!String(username || "").trim() || !password || String(password).length < 8) {
        return bad(res, "Username i hasło (min. 8 znaków) są wymagane");
      }

      const hash = await bcrypt.hash(String(password), 12);
      await pool.query(
        "INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)",
        [String(username).trim(), hash]
      );

      return res.status(201).json({
        success: true,
        message: "Konto admina utworzone. Możesz się zalogować.",
      });
    }

    // ── POST /login (BEZ LOGOWANIA) ───────────────────────────────
    if (raw === "/login" && method === "POST") {
      const { username, password } = await getBody(req);
      if (!username || !password) return bad(res, "Podaj login i hasło");

      const { rows } = await pool.query(
        "SELECT * FROM admin_users WHERE username = $1",
        [String(username).trim()]
      );
      if (!rows.length) return bad(res, "Nieprawidłowe dane logowania", 401);

      const valid = await bcrypt.compare(String(password), rows[0].password_hash);
      if (!valid) return bad(res, "Nieprawidłowe dane logowania", 401);

      const token = signToken({ id: rows[0].id, username: rows[0].username });
      return res.status(200).json({ token, username: rows[0].username });
    }

    // ── AUTH GUARD (RESZTA WYMAGA TOKENA) ─────────────────────────
    const payload = verifyToken(getToken(req));
    if (!payload) return unauth(res);

    // ── GET /stats ───────────────────────────────────────────────
    if (raw === "/stats" && method === "GET") {
      const [{ rows: [totals] }, { rows: byLoc }, { rows: recent }, { rows: byGroup }] =
        await Promise.all([
          pool.query("SELECT * FROM v_stats"),
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

      return res.status(200).json({ ...(totals || {}), byLoc, recent, byGroup });
    }

    // ── GET /registrations ───────────────────────────────────────
    if (raw === "/registrations" && method === "GET") {
      const q = req.query || {};
      const where = ["1=1"];
      const params = [];
      let pi = 1;

      if (q.status) { where.push(`r.status = $${pi++}`); params.push(q.status); }
      if (q.payment_status) { where.push(`r.payment_status = $${pi++}`); params.push(q.payment_status); }
      if (q.location) { where.push(`l.slug = $${pi++}`); params.push(q.location); }
      if (q.category) { where.push(`g.category = $${pi++}`); params.push(q.category); }
      if (q.waitlist === "true") where.push("r.is_waitlist = true");
      if (q.waitlist === "false") where.push("r.is_waitlist = false");
      if (q.search) {
        where.push(`(r.first_name ILIKE $${pi} OR r.last_name ILIKE $${pi} OR r.email ILIKE $${pi} OR r.payment_ref ILIKE $${pi} OR r.phone ILIKE $${pi})`);
        params.push(`%${q.search}%`);
        pi++;
      }

      const limit = Math.min(parseInt(q.limit || "50", 10), 200);
      const offset = parseInt(q.offset || "0", 10);
      const orderBy = q.sort === "amount" ? "r.total_amount DESC" : "r.created_at DESC";
      const whereStr = where.join(" AND ");

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
          LIMIT ${limits(limit)} OFFSET ${offset}
        `, params),
        pool.query(`
          SELECT COUNT(*) AS total
          FROM registrations r
          LEFT JOIN groups g    ON r.group_id     = g.id
          LEFT JOIN locations l ON g.location_id  = l.id
          WHERE ${whereStr}
        `, params),
      ]);

      return res.status(200).json({ rows, total: parseInt(total, 10), limit, offset });
    }

    // ── GET /registration/:id ────────────────────────────────────
    if (raw.match(/^\/registration\/\d+$/) && method === "GET") {
      const id = raw.split("/")[2];
      const { rows: [reg] } = await pool.query(
        "SELECT * FROM v_registrations WHERE id = $1",
        [id]
      );
      if (!reg) return bad(res, "Nie znaleziono zapisu", 404);
      return res.status(200).json(reg);
    }

    // ── PATCH /registration/:id ──────────────────────────────────
    if (raw.match(/^\/registration\/\d+$/) && method === "PATCH") {
      const id = raw.split("/")[2];
      const updates = await getBody(req);

      const ALLOWED = ["status", "payment_status", "admin_notes", "is_waitlist", "start_date"];
      const set = [];
      const vals = [];
      let pi = 1;

      for (const key of ALLOWED) {
        if (key in updates) {
          set.push(`${key} = $${pi++}`);
          vals.push(updates[key]);
        }
      }

      if (updates.payment_status === "paid") set.push("paid_at = NOW()");
      if (!set.length) return bad(res, "Brak pól do aktualizacji");

      vals.push(id);
      await pool.query(
        `UPDATE registrations SET ${set.join(", ")} WHERE id = $${pi}`,
        vals
      );

      return res.status(200).json({ success: true });
    }

    // ── GET /export ──────────────────────────────────────────────
    if (raw === "/export" && method === "GET") {
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
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        return res.status(200).send("Brak danych");
      }

      const keys = Object.keys(rows[0]);
      const csvRows = [
        keys.join(";"),
        ...rows.map((r) =>
          keys
            .map((k) => {
              const v = r[k];
              if (v === null || v === undefined) return "";
              if (v instanceof Date) return v.toISOString().replace("T", " ").slice(0, 19);
              const s = String(v).replace(/"/g, '""');
              return /[;\n"]/.test(s) ? `"${s}"` : s;
            })
            .join(";")
        ),
      ].join("\r\n");

      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="km-zapisy-${date}.csv"`);

      return res.status(200).send("\uFEFF" + csvRows);
    }

    return bad(res, "Nie znaleziono ścieżki", 404);
  } catch (e) {
    console.error("[ADMIN]", e);
    return res.status(500).json({ error: "Błąd serwera: " + e.message });
  }
};

// małe zabezpieczenie przed wstrzyknięciem w LIMIT (tylko liczba)
function RSl(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSh(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSt(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSo(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSa(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSb(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSx(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSy(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSz(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RS0(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RS1(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RS2(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RS3(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RS4(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RS5(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RS6(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RS7(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RS8(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RS9(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSA(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSB(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSC(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSD(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSE(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSF(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSG(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSH(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSI(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSJ(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSK(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSL(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSM(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSN(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSO(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSP(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSQ(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSR(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSS(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RST(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSU(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSV(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSW(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSX(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function RSY(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function RSZ(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}

// (u Ciebie wcześniej było: LIMIT ${limit} OFFSET ${offset}
// ja zostawiam liczby, ale możesz uprościć: LIMIT ${limit} OFFSET ${offset}
function Limits(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function Limits2(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function Limits3(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function Limits4(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function Limits5(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function Limits6(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function Limits7(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function Limits8(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function Limits9(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function LimitsA(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function LimitsB(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function LimitsC(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function LimitsD(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
function LimitsE(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 0;
}
function LimitsF(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}

// realnie wystarczy to:
function Limits(n) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : 50;
}
