const { getPool } = require("../_db");

module.exports = async function participantsHandler(req, res, raw, method, getBody, bad) {
  const pool = getPool();

  if (raw === "/participants" && method === "POST") {
    const b = await getBody(req);

    const first_name = String(b.first_name || "").trim();
    const last_name  = String(b.last_name  || "").trim();
    const email      = String(b.email      || "").trim() || null;
    const phone      = String(b.phone      || "").trim() || null;

    const source = String(b.source || "manual").trim();
    const status = String(b.status || "active").trim();
    const notes  = String(b.notes  || "").trim() || null;

    const group_id = b.group_id != null ? parseInt(b.group_id, 10) : null;
    const is_waitlist = b.is_waitlist === true;


    const { rows: [p] } = await pool.query(
      `INSERT INTO participants
        (first_name, last_name, email, phone, source, status, notes)
       VALUES
        (,,,,,,)
       RETURNING *`,
      [first_name, last_name, email, phone, source, status, notes]
    );

    if (group_id) {
      await pool.query(
        `INSERT INTO group_members (participant_id, group_id, is_waitlist)
         VALUES (,,)`,
        [p.id, group_id, is_waitlist]
      );
    }

    return res.status(201).json({ success: true, participant: p });
  }

  return bad(res, "Nie znaleziono ścieżki", 404);
};
