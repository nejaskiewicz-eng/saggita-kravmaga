// api/admin-api/[...path].js
const jwt = require("jsonwebtoken");
const { getPool } = require("../_db"); // api/_db.js

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function getToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function requireAuth(req) {
  const token = getToken(req);
  if (!token) return null;

  const secret = process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET;
  if (!secret) return null;

  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

function asInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function csvEscape(v) {
  const s = (v ?? "").toString();
  if (/[",\n\r;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const pathArr = req.query.path || [];
  const path = Array.isArray(pathArr) ? pathArr.join("/") : String(pathArr || "");
  const seg = path ? path.split("/") : [];

  // ✅ LOGIN NIE DOTYKA BAZY
  if (req.method === "POST" && seg[0] === "login") {
    const body = await readJson(req);
    const username = (body.username || "").toString().trim();
    const password = (body.password || "").toString();

    const u = (process.env.ADMIN_USER || "").toString();
    const p = (process.env.ADMIN_PASS || "").toString();
    const secret = (process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET || "").toString();

    if (!u || !p || !secret) {
      return res.status(500).json({
        error: "Brak konfiguracji ADMIN_USER / ADMIN_PASS / JWT_SECRET w Vercelu.",
      });
    }

    if (username !== u || password !== p) {
      return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
    }

    const token = jwt.sign({ username }, secret, { expiresIn: "12h" });
    return res.status(200).json({ token });
  }

  // ✅ RESZTA wymaga tokena
  const user = requireAuth(req);
  if (!user) return res.status(401).json({ error: "Brak autoryzacji." });

  // ✅ BAZĘ OTWIERAMY DOPIERO TERAZ (po loginie)
  let pool;
  try {
    pool = getPool();
  } catch (e) {
    console.error("[admin-api] getPool failed:", e);
    return res.status(500).json({ error: "Błąd połączenia z bazą (DATABASE_URL)." });
  }

  // GET /stats
  if (req.method === "GET" && seg[0] === "stats") {
    try {
      const [{ rows: totalR }, { rows: byLoc }, { rows: byGroup }, { rows: recent }] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total,
                           COUNT(*) FILTER (WHERE payment_status='paid')::int AS paid,
                           COUNT(*) FILTER (WHERE payment_status='pending')::int AS pending,
                           COUNT(*) FILTER (WHERE is_waitlist=true)::int AS waitlist
                      FROM registrations
                     WHERE status NOT IN ('cancelled')`),

        pool.query(`
          SELECT l.city,
                 COUNT(r.id)::int AS total,
                 COUNT(r.id) FILTER (WHERE r.payment_status='paid')::int AS paid,
                 COUNT(r.id) FILTER (WHERE r.payment_status='pending')::int AS pending,
                 COUNT(r.id) FILTER (WHERE r.is_waitlist=true)::int AS waitlist
            FROM locations l
            LEFT JOIN groups g ON g.location_id = l.id
            LEFT JOIN registrations r ON r.group_id = g.id AND r.status NOT IN ('cancelled')
           WHERE l.active = true
           GROUP BY l.city
           ORDER BY l.city
        `),

        pool.query(`
          SELECT l.city, g.id, g.name, g.max_capacity,
                 COUNT(r.id) FILTER (WHERE r.status NOT IN ('cancelled') AND r.is_waitlist=false)::int AS registered,
                 g.max_capacity
            FROM groups g
            JOIN locations l ON l.id = g.location_id
            LEFT JOIN registrations r ON r.group_id = g.id
           WHERE g.active = true AND l.active = true
           GROUP BY l.city, g.id, g.name, g.max_capacity
           ORDER BY l.city, g.name
        `),

        pool.query(`
          SELECT r.id,
                 (r.first_name || ' ' || r.last_name) AS name,
                 l.city,
                 g.name AS group_name,
                 r.status,
                 r.payment_status,
                 r.created_at
            FROM registrations r
            LEFT JOIN groups g ON g.id = r.group_id
            LEFT JOIN locations l ON l.id = g.location_id
           ORDER BY r.created_at DESC
           LIMIT 10
        `),
      ]);

      const t = totalR[0] || { total: 0, paid: 0, pending: 0, waitlist: 0 };
      return res.status(200).json({
        total: t.total,
        paid: t.paid,
        pending: t.pending,
        waitlist: t.waitlist,
        byLoc,
        byGroup: (byGroup || []).map(g => ({
          city: g.city,
          id: g.id,
          name: g.name,
          max_capacity: g.max_capacity,
          registered: g.registered
        })),
        recent,
      });
    } catch (e) {
      console.error("[admin-api/stats]", e);
      return res.status(500).json({ error: "Błąd statystyk." });
    }
  }

  // GET /locations
  if (req.method === "GET" && seg[0] === "locations") {
    try {
      const { rows } = await pool.query(`
        SELECT l.*,
               (SELECT COUNT(*) FROM groups g WHERE g.location_id=l.id)::int AS groups_count,
               (SELECT COUNT(*)
                  FROM registrations r
                  JOIN groups g ON g.id=r.group_id
                 WHERE g.location_id=l.id AND r.status NOT IN ('cancelled'))::int AS registrations_count
          FROM locations l
         ORDER BY l.id
      `);
      return res.status(200).json({ rows });
    } catch (e) {
      console.error("[admin-api/locations]", e);
      return res.status(500).json({ error: "Błąd pobierania lokalizacji." });
    }
  }

  // POST /locations
  if (req.method === "POST" && seg[0] === "locations") {
    const body = await readJson(req);
    try {
      const { city, slug, name, address, venue, active } = body || {};
      if (!city || !slug || !name) return res.status(400).json({ error: "Miasto, slug i nazwa są wymagane." });

      await pool.query(
        `INSERT INTO locations (city,slug,name,address,venue,active)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [city, slug, name, address || null, venue || null, active !== false]
      );

      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/locations POST]", e);
      return res.status(500).json({ error: "Błąd dodawania lokalizacji." });
    }
  }

  // PATCH /locations/:id
  if (req.method === "PATCH" && seg[0] === "locations" && seg[1]) {
    const id = asInt(seg[1]);
    const body = await readJson(req);
    try {
      await pool.query(
        `UPDATE locations
            SET city=COALESCE($2,city),
                slug=COALESCE($3,slug),
                name=COALESCE($4,name),
                address=$5,
                venue=$6,
                active=COALESCE($7,active)
          WHERE id=$1`,
        [id, body.city || null, body.slug || null, body.name || null, body.address ?? null, body.venue ?? null,
          typeof body.active === "boolean" ? body.active : null]
      );
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/locations PATCH]", e);
      return res.status(500).json({ error: "Błąd aktualizacji lokalizacji." });
    }
  }

  // GET /groups
  if (req.method === "GET" && seg[0] === "groups" && !seg[1]) {
    try {
      const { rows } = await pool.query(`
        SELECT g.*,
               l.city,
               (SELECT COUNT(*)
                  FROM registrations r
                 WHERE r.group_id=g.id AND r.status NOT IN ('cancelled') AND r.is_waitlist=false)::int AS registered_count
          FROM groups g
          LEFT JOIN locations l ON l.id=g.location_id
         ORDER BY l.city NULLS LAST, g.id
      `);
      return res.status(200).json({ rows });
    } catch (e) {
      console.error("[admin-api/groups]", e);
      return res.status(500).json({ error: "Błąd pobierania grup." });
    }
  }

  // POST /groups
  if (req.method === "POST" && seg[0] === "groups" && !seg[1]) {
    const body = await readJson(req);
    try {
      if (!body.name || !body.location_id) return res.status(400).json({ error: "Nazwa i lokalizacja są wymagane." });

      await pool.query(
        `INSERT INTO groups (location_id,name,category,age_range,max_capacity,active,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          asInt(body.location_id),
          body.name,
          body.category || "adults",
          body.age_range || null,
          asInt(body.max_capacity) || 20,
          body.active !== false,
          body.notes || null,
        ]
      );

      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/groups POST]", e);
      return res.status(500).json({ error: "Błąd dodawania grupy." });
    }
  }

  // PATCH /groups/:id
  if (req.method === "PATCH" && seg[0] === "groups" && seg[1] && !seg[2]) {
    const id = asInt(seg[1]);
    const body = await readJson(req);
    try {
      await pool.query(
        `UPDATE groups
            SET location_id=$2,
                name=COALESCE($3,name),
                category=COALESCE($4,category),
                age_range=$5,
                max_capacity=COALESCE($6,max_capacity),
                active=COALESCE($7,active),
                notes=$8
          WHERE id=$1`,
        [
          id,
          body.location_id === null ? null : asInt(body.location_id),
          body.name || null,
          body.category || null,
          body.age_range ?? null,
          body.max_capacity != null ? asInt(body.max_capacity) : null,
          typeof body.active === "boolean" ? body.active : null,
          body.notes ?? null,
        ]
      );
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/groups PATCH]", e);
      return res.status(500).json({ error: "Błąd aktualizacji grupy." });
    }
  }

  // DELETE /groups/:id
  if (req.method === "DELETE" && seg[0] === "groups" && seg[1] && !seg[2]) {
    const id = asInt(seg[1]);
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt
           FROM registrations
          WHERE group_id=$1 AND status NOT IN ('cancelled')`,
        [id]
      );
      if ((rows[0]?.cnt || 0) > 0) return res.status(400).json({ error: "Nie można usunąć grupy z zapisami." });

      await pool.query(`DELETE FROM schedules WHERE group_id=$1`, [id]);
      await pool.query(`DELETE FROM groups WHERE id=$1`, [id]);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/groups DELETE]", e);
      return res.status(500).json({ error: "Błąd usuwania grupy." });
    }
  }

  // GET /groups/:id/members
  if (req.method === "GET" && seg[0] === "groups" && seg[1] && seg[2] === "members") {
    const gid = asInt(seg[1]);
    try {
      const { rows } = await pool.query(
        `SELECT id, first_name, last_name, email, phone, status, payment_status
           FROM registrations
          WHERE group_id=$1 AND status NOT IN ('cancelled')
          ORDER BY created_at DESC`,
        [gid]
      );
      return res.status(200).json({ rows });
    } catch (e) {
      console.error("[admin-api/groups members]", e);
      return res.status(500).json({ error: "Błąd pobierania kursantów grupy." });
    }
  }

  // GET /schedules
  if (req.method === "GET" && seg[0] === "schedules" && !seg[1]) {
    try {
      const { rows } = await pool.query(`
        SELECT s.*,
               g.name AS group_name,
               g.category,
               g.id AS group_id,
               l.city
          FROM schedules s
          LEFT JOIN groups g ON g.id=s.group_id
          LEFT JOIN locations l ON l.id=g.location_id
         ORDER BY s.day_of_week NULLS LAST, s.time_start
      `);
      return res.status(200).json({ rows });
    } catch (e) {
      console.error("[admin-api/schedules]", e);
      return res.status(500).json({ error: "Błąd pobierania grafiku." });
    }
  }

  // POST /schedules
  if (req.method === "POST" && seg[0] === "schedules" && !seg[1]) {
    const body = await readJson(req);
    try {
      if (body.group_id == null) return res.status(400).json({ error: "Brak group_id." });

      await pool.query(
        `INSERT INTO schedules (group_id,day_of_week,time_start,time_end,address,active)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          asInt(body.group_id),
          asInt(body.day_of_week),
          body.time_start || null,
          body.time_end || null,
          body.address || null,
          body.active !== false,
        ]
      );

      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/schedules POST]", e);
      return res.status(500).json({ error: "Błąd dodawania terminu." });
    }
  }

  // PATCH /schedules/:id
  if (req.method === "PATCH" && seg[0] === "schedules" && seg[1]) {
    const id = asInt(seg[1]);
    const body = await readJson(req);
    try {
      await pool.query(
        `UPDATE schedules
            SET group_id=COALESCE($2,group_id),
                day_of_week=COALESCE($3,day_of_week),
                time_start=$4,
                time_end=$5,
                address=$6,
                active=COALESCE($7,active)
          WHERE id=$1`,
        [
          id,
          body.group_id != null ? asInt(body.group_id) : null,
          body.day_of_week != null ? asInt(body.day_of_week) : null,
          body.time_start ?? null,
          body.time_end ?? null,
          body.address ?? null,
          typeof body.active === "boolean" ? body.active : null,
        ]
      );
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/schedules PATCH]", e);
      return res.status(500).json({ error: "Błąd aktualizacji terminu." });
    }
  }

  // DELETE /schedules/:id
  if (req.method === "DELETE" && seg[0] === "schedules" && seg[1]) {
    const id = asInt(seg[1]);
    try {
      await pool.query(`DELETE FROM schedules WHERE id=$1`, [id]);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/schedules DELETE]", e);
      return res.status(500).json({ error: "Błąd usuwania terminu." });
    }
  }

  // GET /plans
  if (req.method === "GET" && seg[0] === "plans") {
    try {
      const { rows } = await pool.query(`SELECT * FROM price_plans WHERE active=true ORDER BY sort_order`);
      return res.status(200).json({ rows });
    } catch (e) {
      console.error("[admin-api/plans]", e);
      return res.status(500).json({ error: "Błąd pobierania planów." });
    }
  }

  // GET /registrations
  if (req.method === "GET" && seg[0] === "registrations" && !seg[1]) {
    try {
      const q = req.query || {};
      const limit = Math.min(200, Math.max(1, asInt(q.limit) || 30));
      const offset = Math.max(0, asInt(q.offset) || 0);

      const where = [];
      const params = [];
      let i = 1;

      if (q.source) { where.push(`r.source = $${i++}`); params.push(q.source); }
      if (q.status) { where.push(`r.status = $${i++}`); params.push(q.status); }
      if (q.payment_status) { where.push(`r.payment_status = $${i++}`); params.push(q.payment_status); }
      if (q.waitlist === "true") where.push(`r.is_waitlist = true`);
      if (q.waitlist === "false") where.push(`r.is_waitlist = false`);

      if (q.search) {
        where.push(`(
          LOWER(r.first_name) LIKE $${i} OR LOWER(r.last_name) LIKE $${i}
          OR LOWER(r.email) LIKE $${i} OR r.phone LIKE $${i}
        )`);
        params.push(`%${String(q.search).toLowerCase()}%`);
        i++;
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const { rows: cntR } = await pool.query(`SELECT COUNT(*)::int AS total FROM registrations r ${whereSql}`, params);
      const total = cntR[0]?.total || 0;

      const { rows } = await pool.query(
        `
        SELECT r.id, r.first_name, r.last_name, r.email, r.phone, r.created_at,
               r.status, r.payment_status, r.is_waitlist, r.source,
               l.city,
               g.name AS group_name
          FROM registrations r
          LEFT JOIN groups g ON g.id=r.group_id
          LEFT JOIN locations l ON l.id=g.location_id
          ${whereSql}
         ORDER BY r.created_at DESC
         LIMIT ${limit} OFFSET ${offset}
        `,
        params
      );

      return res.status(200).json({ total, rows });
    } catch (e) {
      console.error("[admin-api/registrations]", e);
      return res.status(500).json({ error: "Błąd listy zapisów." });
    }
  }

  // GET /registrations/:id
  if (req.method === "GET" && seg[0] === "registrations" && seg[1]) {
    const id = asInt(seg[1]);
    try {
      const { rows } = await pool.query(
        `
        SELECT r.*,
               l.id AS location_id,
               l.city,
               l.name AS location_name,
               g.name AS group_name,
               s.day_of_week AS schedule_day,
               s.time_start AS schedule_time_start,
               s.time_end AS schedule_time_end,
               p.name AS plan_name
          FROM registrations r
          LEFT JOIN groups g ON g.id=r.group_id
          LEFT JOIN locations l ON l.id=g.location_id
          LEFT JOIN schedules s ON s.id=r.schedule_id
          LEFT JOIN price_plans p ON p.id=r.price_plan_id
         WHERE r.id=$1
         LIMIT 1
        `,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: "Nie znaleziono." });
      return res.status(200).json(rows[0]);
    } catch (e) {
      console.error("[admin-api/registration one]", e);
      return res.status(500).json({ error: "Błąd kartoteki." });
    }
  }

  // PATCH /registrations/:id
  if (req.method === "PATCH" && seg[0] === "registrations" && seg[1]) {
    const id = asInt(seg[1]);
    const body = await readJson(req);
    try {
      await pool.query(
        `
        UPDATE registrations
           SET first_name=COALESCE($2,first_name),
               last_name=COALESCE($3,last_name),
               email=$4,
               phone=$5,
               birth_year=$6,
               is_new=COALESCE($7,is_new),
               group_id=$8,
               schedule_id=$9,
               price_plan_id=$10,
               start_date=$11,
               is_waitlist=COALESCE($12,is_waitlist),
               payment_status=COALESCE($13,payment_status),
               payment_method=COALESCE($14,payment_method),
               total_amount=COALESCE($15,total_amount),
               status=COALESCE($16,status),
               admin_notes=$17
         WHERE id=$1
        `,
        [
          id,
          body.first_name || null,
          body.last_name || null,
          body.email ?? null,
          body.phone ?? null,
          body.birth_year ?? null,
          typeof body.is_new === "boolean" ? body.is_new : null,
          body.group_id === undefined ? null : body.group_id,
          body.schedule_id === undefined ? null : body.schedule_id,
          body.price_plan_id === undefined ? null : body.price_plan_id,
          body.start_date ?? null,
          typeof body.is_waitlist === "boolean" ? body.is_waitlist : null,
          body.payment_status || null,
          body.payment_method || null,
          body.total_amount != null ? Number(body.total_amount) : null,
          body.status || null,
          body.admin_notes ?? null,
        ]
      );
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/registrations PATCH]", e);
      return res.status(500).json({ error: "Błąd zapisu kartoteki." });
    }
  }

  // DELETE /registrations/:id
  if (req.method === "DELETE" && seg[0] === "registrations" && seg[1]) {
    const id = asInt(seg[1]);
    try {
      await pool.query(`UPDATE registrations SET status='cancelled' WHERE id=$1`, [id]);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("[admin-api/registrations DELETE]", e);
      return res.status(500).json({ error: "Błąd usuwania." });
    }
  }

  // POST /participant
  if (req.method === "POST" && seg[0] === "participant") {
    const body = await readJson(req);
    try {
      if (!body.first_name || !body.last_name || !body.group_id) {
        return res.status(400).json({ error: "Imię, nazwisko i grupa są wymagane." });
      }

      const { rows: [r] } = await pool.query(
        `
        INSERT INTO registrations (
          group_id, price_plan_id,
          first_name, last_name, email, phone, birth_year,
          is_new, start_date,
          payment_method, total_amount, payment_status,
          status, admin_notes,
          source, is_waitlist
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'admin',false)
        RETURNING id, first_name, last_name
        `,
        [
          asInt(body.group_id),
          body.price_plan_id ? asInt(body.price_plan_id) : null,
          body.first_name,
          body.last_name,
          body.email ?? null,
          body.phone ?? null,
          body.birth_year ?? null,
          typeof body.is_new === "boolean" ? body.is_new : true,
          body.start_date ?? null,
          body.payment_method || "cash",
          body.total_amount != null ? Number(body.total_amount) : 0,
          body.payment_status || "unpaid",
          body.status || "confirmed",
          body.admin_notes ?? null,
        ]
      );

      return res.status(201).json({ ok: true, id: r.id, name: `${r.first_name} ${r.last_name}` });
    } catch (e) {
      console.error("[admin-api/participant POST]", e);
      return res.status(500).json({ error: "Błąd dodawania kursanta." });
    }
  }

  // GET /export
  if (req.method === "GET" && seg[0] === "export") {
    try {
      const { rows } = await pool.query(`
        SELECT r.id, r.first_name, r.last_name, r.email, r.phone,
               l.city,
               g.name AS group_name,
               r.status, r.payment_status, r.payment_method,
               r.total_amount, r.payment_ref,
               r.is_waitlist, r.created_at
          FROM registrations r
          LEFT JOIN groups g ON g.id=r.group_id
          LEFT JOIN locations l ON l.id=g.location_id
         ORDER BY r.created_at DESC
      `);

      const header = [
        "id","first_name","last_name","email","phone","city","group_name",
        "status","payment_status","payment_method","total_amount","payment_ref",
        "is_waitlist","created_at"
      ];

      const lines = [
        header.join(";"),
        ...rows.map((r) => header.map((k) => csvEscape(r[k])).join(";")),
      ];

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="saggita-export.csv"`);
      return res.status(200).send("\uFEFF" + lines.join("\n"));
    } catch (e) {
      console.error("[admin-api/export]", e);
      return res.status(500).json({ error: "Błąd eksportu." });
    }
  }

  return res.status(404).json({ error: "Nieznany endpoint." });
};
