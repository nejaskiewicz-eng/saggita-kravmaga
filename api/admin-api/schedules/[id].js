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
    // GET — pojedynczy termin (dla podglądu/edycji)
    if (method === "GET") {
      const { rows } = await pool.query(
        `
        SELECT s.*,
               g.name AS group_name, g.category,
               l.city, l.name AS location_name, l.slug AS location_slug
        FROM schedules s
        LEFT JOIN groups g ON s.group_id = g.id
        LEFT JOIN locations l ON g.location_id = l.id
        WHERE s.id = $1
        `,
        [id]
      );

      if (!rows[0]) return res.status(404).json({ error: "Nie znaleziono terminu" });
      return res.status(200).json(rows[0]);
    }

    // PATCH — zapis zmian terminu
    if (method === "PATCH") {
      const updates = req.body || {};

      const ALLOWED = ["group_id", "day_of_week", "time_start", "time_end", "address", "active"];

      const set = [];
      const vals = [];
      let pi = 1;

      for (const key of ALLOWED) {
        if (key in updates) {
          set.push(`${key} = $${pi++}`);
          vals.push(updates[key]);
        }
      }

      if (!set.length) return res.status(400).json({ error: "Brak pól do aktualizacji" });

      vals.push(id);

      const { rowCount } = await pool.query(
        `UPDATE schedules SET ${set.join(", ")} WHERE id = $${pi}`,
        vals
      );

      if (!rowCount) return res.status(404).json({ error: "Nie znaleziono terminu" });

      return res.status(200).json({ success: true });
    }

    // DELETE — usuń termin
    if (method === "DELETE") {
      const { rowCount } = await pool.query("DELETE FROM schedules WHERE id = $1", [id]);
      if (!rowCount) return res.status(404).json({ error: "Nie znaleziono terminu" });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
