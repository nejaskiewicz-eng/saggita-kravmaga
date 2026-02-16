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
    // GET (opcjonalnie, przydatne do debug)
    if (method === "GET") {
      const { rows: [g] } = await pool.query(
        `SELECT g.*,
                l.city,
                l.name AS location_name,
                l.slug AS location_slug,
                (SELECT COUNT(*)::int FROM registrations r WHERE r.group_id = g.id AND COALESCE(r.is_waitlist,false)=false) AS registered_count,
                (SELECT COUNT(*)::int FROM registrations r WHERE r.group_id = g.id AND COALESCE(r.is_waitlist,false)=true)  AS waitlist_count
         FROM groups g
         LEFT JOIN locations l ON g.location_id = l.id
         WHERE g.id = $1`,
        [id]
      );

      if (!g) return res.status(404).json({ error: "Nie znaleziono grupy" });
      return res.status(200).json(g);
    }

    // PATCH — zapis zmian grupy
    if (method === "PATCH") {
      const updates = req.body || {};

      const ALLOWED = [
        "location_id",
        "name",
        "category",
        "age_range",
        "max_capacity",
        "active",
        "notes",
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
        `UPDATE groups SET ${set.join(", ")} WHERE id = $${pi}`,
        vals
      );

      return res.status(200).json({ success: true });
    }

    // DELETE — usuń grupę
    if (method === "DELETE") {
      const { rowCount } = await pool.query(
        "DELETE FROM groups WHERE id = $1",
        [id]
      );

      if (!rowCount) {
        return res.status(404).json({ error: "Nie znaleziono grupy" });
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
