// api/admin-api/participants/index.js
const crypto = require("crypto");
const { getPool } = require("../../_db");

const SECRET = process.env.JWT_SECRET;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
}

function bad(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

function unauth(res) {
  return res.status(401).json({ error: "Brak autoryzacji. Zaloguj się ponownie." });
}

function getToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  return String(auth).replace(/^Bearer\s+/i, "").trim();
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

async function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  try {
    const raw = await new Promise((resolve, reject) => {
      let d = "";
      req.on("data", c => (d += c));
      req.on("end", () => resolve(d));
      req.on("error", reject);
    });
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function toInt(v, fallback) {
  const x = parseInt(String(v ?? ""), 10);
  return Number.isFinite(x) ? x : fallback;
}

function resolveId(req) {
  // 1) /api/admin-api/participants/[id].js → req.query.id
  if (req.query && req.query.id) return String(req.query.id);

  // 2) fallback: parse from URL
  try {
    const full = new URL(req.url, "https://local");
    const p = full.pathname || "";
    const m = p.match(/\/api\/admin-api\/participants\/(\d+)$/);
    if (m) return m[1];
  } catch {}
  return null;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  // auth (tak samo jak w main routerze)
  const payload = verifyToken(getToken(req));
  if (!payload) return unauth(res);

  const pool = getPool();
  const method = req.method;
  const id = resolveId(req);

  try {
    // ─────────────────────────────────────────────────────────────
    // GET /participants (lista, wyszukiwarka)
    // ─────────────────────────────────────────────────────────────
    if (!id && method === "GET") {
      const q = req.query || {};
      const where = ["1=1"];
      const params = [];
      let pi = 1;

      if (q.search) {
        where.push(`(
          p.first_name ILIKE $${pi} OR
          p.last_name  ILIKE $${pi} OR
          p.email      ILIKE $${pi} OR
          p.phone      ILIKE $${pi}
        )`);
        params.push(`%${q.search}%`);
        pi++;
      }

      const limit = Math.min(toInt(q.limit, 50), 200);
      const offset = Math.max(toInt(q.offset, 0), 0);
      const whereStr = where.join(" AND ");

      const [{ rows }, { rows: [{ total }] }] = await Promise.all([
        pool.query(
          `
          SELECT
            p.*,
            gm.group_id,
            gm.is_waitlist,
            g.name AS group_name,
            l.city,
            l.slug AS location_slug
          FROM participants p
          LEFT JOIN group_members gm ON gm.participant_id = p.id
          LEFT JOIN groups g ON g.id = gm.group_id
          LEFT JOIN locations l ON l.id = g.location_id
          WHERE ${whereStr}
          ORDER BY p.id DESC
          LIMIT ${limit} OFFSET ${offset}
          `,
          params
        ),
        pool.query(
          `
          SELECT COUNT(*)::int AS total
          FROM participants p
          WHERE ${whereStr}
          `,
          params
        ),
      ]);

      return res.status(200).json({ rows, total: parseInt(total, 10), limit, offset });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /participants (dodanie kursanta)
    // ─────────────────────────────────────────────────────────────
    if (!id && method === "POST") {
      const b = await getBody(req);

      const first_name = String(b.first_name || "").trim();
      const last_name = String(b.last_name || "").trim();
      const email = String(b.email || "").trim() || null;
      const phone = String(b.phone || "").trim() || null;

      const source = String(b.source || "admin").trim();
      const status = String(b.status || "active").trim();
      const notes = String(b.notes || "").trim() || null;

      const group_id = b.group_id != null ? parseInt(b.group_id, 10) : null;
      const is_waitlist = b.is_waitlist === true;

      if (!first_name || !last_name) return bad(res, "Imię i nazwisko są wymagane");

      const { rows: [p] } = await pool.query(
        `
        INSERT INTO participants
          (first_name, last_name, email, phone, source, status, notes)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [first_name, last_name, email, phone, source, status, notes]
      );

      if (group_id) {
        await pool.query(
          `
          INSERT INTO group_members (participant_id, group_id, is_waitlist)
          VALUES ($1, $2, $3)
          ON CONFLICT (participant_id, group_id) DO UPDATE SET is_waitlist = EXCLUDED.is_waitlist
          `,
          [p.id, group_id, is_waitlist]
        );
      }

      return res.status(201).json({ success: true, participant: p });
    }

    // ─────────────────────────────────────────────────────────────
    // GET /participants/:id (kartoteka)
    // ─────────────────────────────────────────────────────────────
    if (id && method === "GET") {
      const { rows: [p] } = await pool.query(
        `
        SELECT
          p.*,
          gm.group_id,
          gm.is_waitlist,
          g.name AS group_name,
          l.city,
          l.slug AS location_slug
        FROM participants p
        LEFT JOIN group_members gm ON gm.participant_id = p.id
        LEFT JOIN groups g ON g.id = gm.group_id
        LEFT JOIN locations l ON l.id = g.location_id
        WHERE p.id = $1
        `,
        [id]
      );

      if (!p) return bad(res, "Nie znaleziono kursanta", 404);
      return res.status(200).json(p);
    }

    // ─────────────────────────────────────────────────────────────
    // PATCH /participants/:id (edycja)
    // ─────────────────────────────────────────────────────────────
    if (id && method === "PATCH") {
      const b = await getBody(req);

      const ALLOWED = ["first_name", "last_name", "email", "phone", "source", "status", "notes"];
      const set = [];
      const vals = [];
      let pi = 1;

      for (const key of ALLOWED) {
        if (key in b) {
          set.push(`${key} = $${pi++}`);
          vals.push(b[key]);
        }
      }

      if (set.length) {
        vals.push(id);
        await pool.query(`UPDATE participants SET ${set.join(", ")} WHERE id = $${pi}`, vals);
      }

      // opcjonalnie: zmiana przypięcia do grupy
      if ("group_id" in b) {
        const group_id = b.group_id != null ? parseInt(b.group_id, 10) : null;
        const is_waitlist = b.is_waitlist === true;

        // czyścimy stare przypięcia (jeśli chcesz mieć “jedna grupa na osobę”)
        await pool.query(`DELETE FROM group_members WHERE participant_id = $1`, [id]);

        if (group_id) {
          await pool.query(
            `
            INSERT INTO group_members (participant_id, group_id, is_waitlist)
            VALUES ($1, $2, $3)
            `,
            [id, group_id, is_waitlist]
          );
        }
      }

      return res.status(200).json({ success: true });
    }

    // ─────────────────────────────────────────────────────────────
    // DELETE /participants/:id
    // ─────────────────────────────────────────────────────────────
    if (id && method === "DELETE") {
      await pool.query(`DELETE FROM group_members WHERE participant_id = $1`, [id]);
      const { rowCount } = await pool.query(`DELETE FROM participants WHERE id = $1`, [id]);
      if (!rowCount) return bad(res, "Nie znaleziono kursanta", 404);
      return res.status(200).json({ success: true });
    }

    return bad(res, "Nie znaleziono ścieżki", 404);
  } catch (e) {
    // ważne: jak Vercel wywali FUNCTION_INVOCATION_FAILED, to tu zwykle jest przyczyna
    return res.status(500).json({ error: "Błąd serwera", details: e.message });
  }
};
