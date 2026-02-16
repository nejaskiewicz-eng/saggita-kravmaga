// api/admin-api/[...path].js
const jwt = require("jsonwebtoken");
const { getPool } = require("../_db"); // <- ważne: jesteśmy w /api/admin-api, więc idziemy poziom wyżej

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function getToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function verifyAuth(req) {
  const token = getToken(req);
  if (!token) return { ok: false, error: "Brak tokenu." };
  const secret = process.env.JWT_SECRET;
  if (!secret) return { ok: false, error: "Brak JWT_SECRET na serwerze." };

  try {
    const payload = jwt.verify(token, secret);
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, error: "Nieprawidłowy lub wygasły token." };
  }
}

// Vercel zwykle parsuje JSON do req.body, ale NIE ZAWSZE.
// Ten parser robi to pewnie i bezpiecznie.
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        if (!data) return resolve({});
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function pathParts(req) {
  // Vercel dla [...path] daje req.query.path jako string albo array
  const p = req.query?.path;
  if (!p) return [];
  return Array.isArray(p) ? p : [p];
}

function asInt(v, def = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function toBool(v) {
  if (v === true || v === false) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function escapeCsv(s) {
  const v = (s ?? "").toString();
  if (/[",\n;]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end("");

  const parts = pathParts(req);
  const pool = getPool();

  // ===== ROUTE: /login (bez auth) =====
  if (parts[0] === "login") {
    if (req.method !== "POST") return send(res, 405, { error: "Method Not Allowed" });

    const body = await readJsonBody(req);
    const username = (body.username || "").toString().trim();
    const password = (body.password || "").toString();

    const ADMIN_USER = (process.env.ADMIN_USER || "admin").toString();
    const ADMIN_PASS = (process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD || "admin").toString();
    const secret = process.env.JWT_SECRET;

    if (!secret) return send(res, 500, { error: "Brak JWT_SECRET na Vercelu." });

    if (!username || !password) return send(res, 400, { error: "Podaj login i hasło." });
    if (username !== ADMIN_USER || password !== ADMIN_PASS) return send(res, 401, { error: "Błędny login lub hasło." });

    const token = jwt.sign({ id: "1", username: ADMIN_USER }, secret, { expiresIn: "10d" });
    return send(res, 200, { ok: true, token });
  }

  // ===== WSZYSTKO POZA /login WYMAGA JWT =====
  const auth = verifyAuth(req);
  if (!auth.ok) return send(res, 401, { error: auth.error });

  // ===== ROUTE: /stats =====
  if (parts[0] === "stats") {
    if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

    try {
      const [t, paid, pending, waitlist] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM registrations WHERE status NOT IN ('cancelled')`),
        pool.query(`SELECT COUNT(*)::int AS c FROM registrations WHERE payment_status='paid' AND status NOT IN ('cancelled')`),
        pool.query(`SELECT COUNT(*)::int AS c FROM registrations WHERE payment_status='pending' AND status NOT IN ('cancelled')`),
        pool.query(`SELECT COUNT(*)::int AS c FROM registrations WHERE is_waitlist=true AND status NOT IN ('cancelled')`),
      ]);

      const byLoc = await pool.query(`
        SELECT l.city,
               COUNT(r.id)::int AS total,
               COUNT(*) FILTER (WHERE r.payment_status='paid')::int AS paid,
               COUNT(*) FILTER (WHERE r.payment_status='pending')::int AS pending,
               COUNT(*) FILTER (WHERE r.is_waitlist=true)::int AS waitlist
        FROM locations l
        LEFT JOIN groups g ON g.location_id=l.id
        LEFT JOIN registrations r ON r.group_id=g.id AND r.status NOT IN ('cancelled')
        WHERE l.active=true
        GROUP BY l.city
        ORDER BY l.city
      `);

      const byGroup = await pool.query(`
        SELECT l.city, g.id, g.name, g.max_capacity,
               COUNT(r.id)::int AS registered
        FROM groups g
        JOIN locations l ON l.id=g.location_id
        LEFT JOIN registrations r
          ON r.group_id=g.id AND r.status NOT IN ('cancelled') AND r.is_waitlist=false
        WHERE g.active=true
        GROUP BY l.city, g.id, g.name, g.max_capacity
        ORDER BY l.city, g.name
      `);

      const recent = await pool.query(`
        SELECT r.id,
               (r.first_name||' '||r.last_name) AS name,
               l.city,
               g.name AS group_name,
               r.status,
               r.payment_status,
               r.created_at
        FROM registrations r
        LEFT JOIN groups g ON g.id=r.group_id
        LEFT JOIN locations l ON l.id=g.location_id
        ORDER BY r.created_at DESC
        LIMIT 10
      `);

      return send(res, 200, {
        total: t.rows[0]?.c || 0,
        paid: paid.rows[0]?.c || 0,
        pending: pending.rows[0]?.c || 0,
        waitlist: waitlist.rows[0]?.c || 0,
        byLoc: byLoc.rows || [],
        byGroup: byGroup.rows || [],
        recent: recent.rows || [],
      });
    } catch (e) {
      console.error("[admin-api/stats]", e);
      return send(res, 500, { error: "Błąd serwera (stats)." });
    }
  }

  // ===== ROUTE: /plans =====
  if (parts[0] === "plans") {
    if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });
    try {
      const r = await pool.query(`SELECT * FROM price_plans WHERE active=true ORDER BY sort_order, id`);
      return send(res, 200, { rows: r.rows });
    } catch (e) {
      console.error("[admin-api/plans]", e);
      return send(res, 500, { error: "Błąd serwera (plans)." });
    }
  }

  // ===== ROUTE: /locations (GET/POST) i /locations/:id (PATCH) =====
  if (parts[0] === "locations") {
    try {
      if (parts.length === 1) {
        if (req.method === "GET") {
          const r = await pool.query(`
            SELECT l.*,
              (SELECT COUNT(*)::int FROM groups g WHERE g.location_id=l.id) AS groups_count,
              (SELECT COUNT(*)::int
                 FROM registrations r
                 JOIN groups g ON g.id=r.group_id
                WHERE g.location_id=l.id AND r.status NOT IN ('cancelled')
              ) AS registrations_count
            FROM locations l
            ORDER BY l.id
          `);
          return send(res, 200, { rows: r.rows });
        }

        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const city = (body.city || "").toString().trim();
          const slug = (body.slug || "").toString().trim();
          const name = (body.name || "").toString().trim();

          if (!city || !slug || !name) return send(res, 400, { error: "Miasto, slug i nazwa są wymagane." });

          const ins = await pool.query(
            `INSERT INTO locations (city, slug, name, address, venue, active)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING *`,
            [city, slug, name, body.address || null, body.venue || null, toBool(body.active) ?? true]
          );
          return send(res, 201, { ok: true, row: ins.rows[0] });
        }

        return send(res, 405, { error: "Method Not Allowed" });
      }

      // /locations/:id
      const id = asInt(parts[1]);
      if (!id) return send(res, 400, { error: "Brak id." });

      if (req.method === "PATCH") {
        const body = await readJsonBody(req);
        const city = (body.city || "").toString().trim();
        const slug = (body.slug || "").toString().trim();
        const name = (body.name || "").toString().trim();

        if (!city || !slug || !name) return send(res, 400, { error: "Miasto, slug i nazwa są wymagane." });

        const up = await pool.query(
          `UPDATE locations
              SET city=$1, slug=$2, name=$3, address=$4, venue=$5, active=$6
            WHERE id=$7
            RETURNING *`,
          [city, slug, name, body.address || null, body.venue || null, toBool(body.active) ?? true, id]
        );
        return send(res, 200, { ok: true, row: up.rows[0] });
      }

      return send(res, 405, { error: "Method Not Allowed" });
    } catch (e) {
      console.error("[admin-api/locations]", e);
      return send(res, 500, { error: "Błąd serwera (locations)." });
    }
  }

  // ===== ROUTE: /groups (GET/POST), /groups/:id (PATCH/DELETE), /groups/:id/members (GET) =====
  if (parts[0] === "groups") {
    try {
      // /groups/:id/members
      if (parts.length === 3 && parts[2] === "members") {
        const gid = asInt(parts[1]);
        if (!gid) return send(res, 400, { error: "Brak id grupy." });
        if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

        const r = await pool.query(
          `SELECT r.*
           FROM registrations r
           WHERE r.group_id=$1 AND r.status NOT IN ('cancelled')
           ORDER BY r.created_at DESC`,
          [gid]
        );
        return send(res, 200, { rows: r.rows });
      }

      // /groups
      if (parts.length === 1) {
        if (req.method === "GET") {
          const r = await pool.query(`
            SELECT g.*,
                   l.city,
                   (SELECT COUNT(*)::int
                      FROM registrations r
                     WHERE r.group_id=g.id AND r.status NOT IN ('cancelled') AND r.is_waitlist=false
                   ) AS registered_count
            FROM groups g
            LEFT JOIN locations l ON l.id=g.location_id
            ORDER BY l.city NULLS LAST, g.id
          `);
          return send(res, 200, { rows: r.rows });
        }

        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const name = (body.name || "").toString().trim();
          const location_id = asInt(body.location_id);
          if (!name || !location_id) return send(res, 400, { error: "Nazwa i lokalizacja są wymagane." });

          const ins = await pool.query(
            `INSERT INTO groups (location_id, name, category, age_range, max_capacity, active, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING *`,
            [
              location_id,
              name,
              body.category || "adults",
              body.age_range || null,
              asInt(body.max_capacity, 20),
              toBool(body.active) ?? true,
              body.notes || null,
            ]
          );
          return send(res, 201, { ok: true, row: ins.rows[0] });
        }

        return send(res, 405, { error: "Method Not Allowed" });
      }

      // /groups/:id
      const id = asInt(parts[1]);
      if (!id) return send(res, 400, { error: "Brak id." });

      if (req.method === "PATCH") {
        const body = await readJsonBody(req);
        const fields = [];
        const vals = [];
        let i = 1;

        const set = (k, v) => {
          fields.push(`${k}=$${i++}`);
          vals.push(v);
        };

        if (body.location_id !== undefined) set("location_id", body.location_id === null ? null : asInt(body.location_id));
        if (body.name !== undefined) set("name", (body.name || "").toString().trim());
        if (body.category !== undefined) set("category", body.category || null);
        if (body.age_range !== undefined) set("age_range", body.age_range || null);
        if (body.max_capacity !== undefined) set("max_capacity", asInt(body.max_capacity, 20));
        if (body.active !== undefined) set("active", toBool(body.active) ?? true);
        if (body.notes !== undefined) set("notes", body.notes || null);

        if (!fields.length) return send(res, 400, { error: "Brak danych do aktualizacji." });

        vals.push(id);
        const up = await pool.query(`UPDATE groups SET ${fields.join(", ")} WHERE id=$${i} RETURNING *`, vals);
        return send(res, 200, { ok: true, row: up.rows[0] });
      }

      if (req.method === "DELETE") {
        // bezpieczeństwo: grupa musi być pusta
        const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM registrations WHERE group_id=$1 AND status NOT IN ('cancelled')`, [id]);
        if ((cnt.rows[0]?.c || 0) > 0) return send(res, 400, { error: "Grupa nie jest pusta." });

        await pool.query(`DELETE FROM groups WHERE id=$1`, [id]);
        return send(res, 200, { ok: true });
      }

      return send(res, 405, { error: "Method Not Allowed" });
    } catch (e) {
      console.error("[admin-api/groups]", e);
      return send(res, 500, { error: "Błąd serwera (groups)." });
    }
  }

  // ===== ROUTE: /schedules (GET/POST), /schedules/:id (PATCH/DELETE) =====
  if (parts[0] === "schedules") {
    try {
      if (parts.length === 1) {
        if (req.method === "GET") {
          const r = await pool.query(`
            SELECT s.*,
                   g.name AS group_name,
                   g.category,
                   l.city
            FROM schedules s
            LEFT JOIN groups g ON g.id=s.group_id
            LEFT JOIN locations l ON l.id=g.location_id
            ORDER BY s.day_of_week NULLS LAST, s.time_start NULLS LAST, s.id
          `);
          return send(res, 200, { rows: r.rows });
        }

        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const gid = asInt(body.group_id);
          if (!gid) return send(res, 400, { error: "Wybierz grupę." });

          const ins = await pool.query(
            `INSERT INTO schedules (group_id, day_of_week, time_start, time_end, address, active)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING *`,
            [
              gid,
              asInt(body.day_of_week, null),
              body.time_start || null,
              body.time_end || null,
              body.address || null,
              toBool(body.active) ?? true,
            ]
          );
          return send(res, 201, { ok: true, row: ins.rows[0] });
        }

        return send(res, 405, { error: "Method Not Allowed" });
      }

      const id = asInt(parts[1]);
      if (!id) return send(res, 400, { error: "Brak id." });

      if (req.method === "PATCH") {
        const body = await readJsonBody(req);
        const up = await pool.query(
          `UPDATE schedules
              SET group_id=$1, day_of_week=$2, time_start=$3, time_end=$4, address=$5, active=$6
            WHERE id=$7
            RETURNING *`,
          [
            asInt(body.group_id),
            asInt(body.day_of_week, null),
            body.time_start || null,
            body.time_end || null,
            body.address || null,
            toBool(body.active) ?? true,
            id,
          ]
        );
        return send(res, 200, { ok: true, row: up.rows[0] });
      }

      if (req.method === "DELETE") {
        await pool.query(`DELETE FROM schedules WHERE id=$1`, [id]);
        return send(res, 200, { ok: true });
      }

      return send(res, 405, { error: "Method Not Allowed" });
    } catch (e) {
      console.error("[admin-api/schedules]", e);
      return send(res, 500, { error: "Błąd serwera (schedules)." });
    }
  }

  // ===== ROUTE: /registrations (GET), /registrations/:id (GET/PATCH/DELETE) =====
  if (parts[0] === "registrations") {
    try {
      // /registrations
      if (parts.length === 1) {
        if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

        const q = req.query || {};
        const limit = Math.min(200, Math.max(1, asInt(q.limit, 30)));
        const offset = Math.max(0, asInt(q.offset, 0));

        const where = [];
        const vals = [];
        let i = 1;

        const add = (sql, v) => {
          where.push(sql.replace("?", `$${i++}`));
          vals.push(v);
        };

        if (q.source) add(`r.source = ?`, q.source);
        if (q.status) add(`r.status = ?`, q.status);
        if (q.payment_status) add(`r.payment_status = ?`, q.payment_status);
        if (q.waitlist !== undefined && q.waitlist !== "") add(`r.is_waitlist = ?`, q.waitlist === "true");

        if (q.search) {
          const s = `%${String(q.search).trim().toLowerCase()}%`;
          where.push(`(
            LOWER(r.first_name) LIKE $${i} OR
            LOWER(r.last_name) LIKE $${i} OR
            LOWER(r.email) LIKE $${i} OR
            LOWER(r.phone) LIKE $${i}
          )`);
          vals.push(s);
          i++;
        }

        const W = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const totalR = await pool.query(`SELECT COUNT(*)::int AS c FROM registrations r ${W}`, vals);

        const rowsR = await pool.query(
          `
          SELECT r.id, r.first_name, r.last_name, r.email, r.phone,
                 r.status, r.payment_status, r.is_waitlist, r.created_at,
                 l.city,
                 g.name AS group_name
          FROM registrations r
          LEFT JOIN groups g ON g.id=r.group_id
          LEFT JOIN locations l ON l.id=g.location_id
          ${W}
          ORDER BY r.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
          `,
          vals
        );

        return send(res, 200, { total: totalR.rows[0]?.c || 0, rows: rowsR.rows });
      }

      // /registrations/:id
      const id = asInt(parts[1]);
      if (!id) return send(res, 400, { error: "Brak id." });

      if (req.method === "GET") {
        const r = await pool.query(
          `
          SELECT r.*,
                 g.name AS group_name,
                 g.category AS group_category,
                 l.id AS location_id,
                 l.city,
                 l.name AS location_name,
                 s.day_of_week AS schedule_day,
                 s.time_start AS schedule_time_start,
                 s.time_end AS schedule_time_end
          FROM registrations r
          LEFT JOIN groups g ON g.id=r.group_id
          LEFT JOIN locations l ON l.id=g.location_id
          LEFT JOIN schedules s ON s.id=r.schedule_id
          WHERE r.id=$1
          LIMIT 1
          `,
          [id]
        );
        if (!r.rows.length) return send(res, 404, { error: "Nie znaleziono." });
        return send(res, 200, r.rows[0]);
      }

      if (req.method === "PATCH") {
        const body = await readJsonBody(req);
        const fields = [];
        const vals = [];
        let i = 1;

        const set = (k, v) => {
          fields.push(`${k}=$${i++}`);
          vals.push(v);
        };

        // dozwolone pola
        const map = {
          first_name: "first_name",
          last_name: "last_name",
          email: "email",
          phone: "phone",
          birth_year: "birth_year",
          is_new: "is_new",
          group_id: "group_id",
          schedule_id: "schedule_id",
          price_plan_id: "price_plan_id",
          start_date: "start_date",
          is_waitlist: "is_waitlist",
          payment_status: "payment_status",
          payment_method: "payment_method",
          total_amount: "total_amount",
          status: "status",
          admin_notes: "admin_notes",
        };

        Object.keys(map).forEach((k) => {
          if (body[k] !== undefined) set(map[k], body[k]);
        });

        if (!fields.length) return send(res, 400, { error: "Brak danych do aktualizacji." });

        vals.push(id);
        const up = await pool.query(`UPDATE registrations SET ${fields.join(", ")} WHERE id=$${i} RETURNING id`, vals);
        return send(res, 200, { ok: true, id: up.rows[0]?.id });
      }

      if (req.method === "DELETE") {
        await pool.query(`UPDATE registrations SET status='cancelled' WHERE id=$1`, [id]);
        return send(res, 200, { ok: true });
      }

      return send(res, 405, { error: "Method Not Allowed" });
    } catch (e) {
      console.error("[admin-api/registrations]", e);
      return send(res, 500, { error: "Błąd serwera (registrations)." });
    }
  }

  // ===== ROUTE: /participant (POST) =====
  if (parts[0] === "participant") {
    if (req.method !== "POST") return send(res, 405, { error: "Method Not Allowed" });

    try {
      const body = await readJsonBody(req);
      const fn = (body.first_name || "").toString().trim();
      const ln = (body.last_name || "").toString().trim();
      const gid = asInt(body.group_id);

      if (!fn || !ln || !gid) return send(res, 400, { error: "Imię, nazwisko i grupa są wymagane." });

      const ins = await pool.query(
        `
        INSERT INTO registrations (
          first_name, last_name, email, phone, birth_year, is_new,
          group_id, schedule_id, price_plan_id, start_date,
          payment_method, total_amount, payment_status,
          admin_notes, is_waitlist, status, source
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13,
          $14,$15,$16,$17
        )
        RETURNING id, first_name, last_name
        `,
        [
          fn,
          ln,
          body.email || null,
          body.phone || null,
          body.birth_year || null,
          body.is_new === false ? false : true,
          gid,
          body.schedule_id || null,
          body.price_plan_id || null,
          body.start_date || null,
          body.payment_method || "cash",
          body.total_amount || 0,
          body.payment_status || "unpaid",
          body.admin_notes || null,
          body.is_waitlist === true,
          body.status || "confirmed",
          "admin",
        ]
      );

      const r = ins.rows[0];
      return send(res, 201, { ok: true, id: r.id, name: `${r.first_name} ${r.last_name}` });
    } catch (e) {
      console.error("[admin-api/participant]", e);
      return send(res, 500, { error: "Błąd serwera (participant)." });
    }
  }

  // ===== ROUTE: /export (CSV) =====
  if (parts[0] === "export") {
    if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

    try {
      const r = await pool.query(`
        SELECT r.id, r.first_name, r.last_name, r.email, r.phone, r.status, r.payment_status, r.created_at,
               l.city, g.name AS group_name
        FROM registrations r
        LEFT JOIN groups g ON g.id=r.group_id
        LEFT JOIN locations l ON l.id=g.location_id
        ORDER BY r.created_at DESC
      `);

      const header = [
        "id","first_name","last_name","email","phone","city","group_name","status","payment_status","created_at"
      ].join(";");

      const lines = r.rows.map(x => ([
        x.id,
        x.first_name,
        x.last_name,
        x.email,
        x.phone,
        x.city,
        x.group_name,
        x.status,
        x.payment_status,
        x.created_at
      ]).map(escapeCsv).join(";"));

      const csv = [header, ...lines].join("\n");

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="export.csv"`);
      return res.end(csv);
    } catch (e) {
      console.error("[admin-api/export]", e);
      res.statusCode = 500;
      return res.end("Błąd serwera (export).");
    }
  }

  // ===== FALLBACK =====
  return send(res, 404, { error: "Nie znaleziono endpointu." });
};
