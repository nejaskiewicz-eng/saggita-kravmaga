// api/admin-api/participants.js
const { getPool } = require("../_db");

module.exports = async function participantsHandler(req, res, raw, method, getBody, bad) {
  const pool = getPool();

  // helpers
  const toInt = (v, fb = null) => {
    const x = parseInt(String(v ?? ""), 10);
    return Number.isFinite(x) ? x : fb;
  };
  const toBool = (v) => v === true || v === "true" || v === 1 || v === "1";

  // ─────────────────────────────────────────────────────────────
  // GET /participants  (lista kursantów)
  // query: search, status, source, group_id, limit, offset
  // ─────────────────────────────────────────────────────────────
  if (raw === "/participants" && method === "GET") {
    const q = req.query || {};
    const where = ["1=1"];
    const params = [];
    let pi = 1;

    if (q.status) { where.push(`p.status = $${pi++}`); params.push(String(q.status)); }
    if (q.source) { where.push(`p.source = $${pi++}`); params.push(String(q.source)); }
    if (q.group_id) { where.push(`gm.group_id = $${pi++}`); params.push(toInt(q.group_id)); }

    if (q.search) {
      where.push(`(
        p.first_name ILIKE $${pi} OR
        p.last_name  ILIKE $${pi} OR
        p.email      ILIKE $${pi} OR
        p.phone      ILIKE $${pi}
      )`);
      params.push(`%${String(q.search)}%`);
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
          l.slug AS location_slug,
          l.name AS location_name
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
        LEFT JOIN group_members gm ON gm.participant_id = p.id
        WHERE ${whereStr}
        `,
        params
      ),
    ]);

    return res.status(200).json({ rows, total: parseInt(total, 10), limit, offset });
  }

  // ─────────────────────────────────────────────────────────────
  // GET /participants/:id  (kartoteka)
  // ─────────────────────────────────────────────────────────────
  if (raw.match(/^\/participants\/\d+$/) && method === "GET") {
    const id = raw.split("/")[2];

    const { rows: [p] } = await pool.query(
      `
      SELECT
        p.*,
        gm.group_id,
        gm.is_waitlist,
        g.name AS group_name,
        l.city,
        l.slug AS location_slug,
        l.name AS location_name
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
  // POST /participants  (dodaj kursanta)
  // body: first_name, last_name, email?, phone?, source?, status?, notes?, group_id?, is_waitlist?
  // ─────────────────────────────────────────────────────────────
  if (raw === "/participants" && method === "POST") {
    const b = await getBody(req);

    const first_name = String(b.first_name || "").trim();
    const last_name  = String(b.last_name  || "").trim();
    const email      = String(b.email      || "").trim() || null;
    const phone      = String(b.phone      || "").trim() || null;

    const source = String(b.source || "admin").trim();
    const status = String(b.status || "active").trim();
    const notes  = String(b.notes  || "").trim() || null;

    const group_id = b.group_id != null ? toInt(b.group_id, null) : null;
    const is_waitlist = toBool(b.is_waitlist);

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

    if (group_id != null) {
      await pool.query(
        `
        INSERT INTO group_members (participant_id, group_id, is_waitlist)
        VALUES ($1, $2, $3)
        ON CONFLICT (participant_id) DO UPDATE
          SET group_id = EXCLUDED.group_id,
              is_waitlist = EXCLUDED.is_waitlist
        `,
        [p.id, group_id, is_waitlist]
      );
    }

    return res.status(201).json({ success: true, participant: p });
  }

  // ─────────────────────────────────────────────────────────────
  // PATCH /participants/:id  (edycja kartoteki + grupa)
  // body: first_name?, last_name?, email?, phone?, source?, status?, notes?, group_id?, is_waitlist?
  // ─────────────────────────────────────────────────────────────
  if (raw.match(/^\/participants\/\d+$/) && method === "PATCH") {
    const id = raw.split("/")[2];
    const u = await getBody(req);

    const ALLOWED = ["first_name","last_name","email","phone","source","status","notes"];
    const set = [];
    const vals = [];
    let pi = 1;

    for (const k of ALLOWED) {
      if (k in u) { set.push(`${k} = $${pi++}`); vals.push(u[k]); }
    }

    const hasGroup = ("group_id" in u) || ("is_waitlist" in u);
    const nextGroup = ("group_id" in u) ? (u.group_id == null ? null : toInt(u.group_id, null)) : undefined;
    const nextWait  = ("is_waitlist" in u) ? toBool(u.is_waitlist) : undefined;

    if (!set.length && !hasGroup) return bad(res, "Brak pól do aktualizacji");

    if (set.length) {
      vals.push(id);
      await pool.query(`UPDATE participants SET ${set.join(", ")} WHERE id = $${pi}`, vals);
    }

    if (hasGroup) {
      const { rows: [cur] } = await pool.query(
        `SELECT group_id, is_waitlist FROM group_members WHERE participant_id = $1`,
        [id]
      );

      const finalGroup = nextGroup !== undefined ? nextGroup : (cur ? cur.group_id : null);
      const finalWait  = nextWait  !== undefined ? nextWait  : (cur ? cur.is_waitlist : false);

      if (finalGroup == null) {
        await pool.query(`DELETE FROM group_members WHERE participant_id = $1`, [id]);
      } else {
        await pool.query(
          `
          INSERT INTO group_members (participant_id, group_id, is_waitlist)
          VALUES ($1, $2, $3)
          ON CONFLICT (participant_id) DO UPDATE
            SET group_id = EXCLUDED.group_id,
                is_waitlist = EXCLUDED.is_waitlist
          `,
          [id, finalGroup, finalWait]
        );
      }
    }

    return res.status(200).json({ success: true });
  }

  // ─────────────────────────────────────────────────────────────
  // DELETE /participants/:id
  // ─────────────────────────────────────────────────────────────
  if (raw.match(/^\/participants\/\d+$/) && method === "DELETE") {
    const id = raw.split("/")[2];
    await pool.query(`DELETE FROM group_members WHERE participant_id = $1`, [id]);
    const { rowCount } = await pool.query(`DELETE FROM participants WHERE id = $1`, [id]);
    if (!rowCount) return bad(res, "Nie znaleziono kursanta", 404);
    return res.status(200).json({ success: true });
  }

  return bad(res, "Nie znaleziono ścieżki", 404);
};
