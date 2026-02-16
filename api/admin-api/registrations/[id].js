const { getPool } = require("../../_db");

module.exports = async (req, res) => {
  const pool = getPool();
  const { id } = req.query;
  const method = req.method;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  if (method === "OPTIONS") return res.status(204).end();

  try {
    // ─── GET — kartoteka ─────────────────────────────
    if (method === "GET") {
      const { rows: [reg] } = await pool.query(`
  SELECT r.*,
         g.name AS group_name, g.category, g.max_capacity,
         l.id AS location_id,
         l.city, l.slug AS location_slug, l.name AS location_name,
         p.name AS plan_name,

         s.id AS schedule_id,
         s.day_of_week AS schedule_day,
         s.time_start AS schedule_time_start,
         s.time_end AS schedule_time_end,
         s.address AS schedule_address
  FROM registrations r
  LEFT JOIN groups g ON r.group_id = g.id
  LEFT JOIN locations l ON g.location_id = l.id
  LEFT JOIN price_plans p ON r.price_plan_id = p.id
  LEFT JOIN schedules s ON r.schedule_id = s.id
  WHERE r.id = $1
`, [id]);


      if (!reg) return res.status(404).json({ error: "Nie znaleziono zapisu" });
      return res.status(200).json(reg);
    }

    // ─── PATCH — zapis zmian ─────────────────────────
    if (method === "PATCH") {
      const updates = req.body || {};

      const ALLOWED = [
        "status", "payment_status", "admin_notes", "is_waitlist", "start_date",
        "first_name", "last_name", "email", "phone", "birth_year",
        "group_id", "price_plan_id", "payment_method", "total_amount",
        "is_new", "preferred_time", "source", "schedule_id"
      ];

      const set = [];
      const vals = [];
      let pi = 1;

      for (const key of ALLOWED) {
        if (key in updates) {
          set.push(`${key} = $${pi++}`);
          vals.push(updates[key]);
        }
      }

      if (!set.length) {
        return res.status(400).json({ error: "Brak pól do aktualizacji" });
      }

      vals.push(id);

      await pool.query(
        `UPDATE registrations SET ${set.join(", ")} WHERE id = $${pi}`,
        vals
      );

      return res.status(200).json({ success: true });
    }

    // ─── DELETE — usuń kursanta ──────────────────────
    if (method === "DELETE") {
      const { rowCount } = await pool.query(
        "DELETE FROM registrations WHERE id = $1",
        [id]
      );

      if (!rowCount) {
        return res.status(404).json({ error: "Nie znaleziono zapisu" });
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
