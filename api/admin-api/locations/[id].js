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
    // GET — pojedyncza lokalizacja (opcjonalnie, ale przydatne)
    if (method === "GET") {
      const { rows } = await pool.query(
        `
        SELECT l.*,
          (SELECT COUNT(*) FROM groups g WHERE g.location_id = l.id) AS groups_count,
          (SELECT COUNT(*) 
             FROM registrations r 
             LEFT JOIN groups g2 ON r.group_id = g2.id
            WHERE g2.location_id = l.id
          ) AS registrations_count
        FROM locations l
        WHERE l.id = $1
        `,
        [id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Nie znaleziono lokalizacji" });
      return res.status(200).json(rows[0]);
    }

    // PATCH — edycja lokalizacji
    if (method === "PATCH") {
      const updates = req.body || {};
      const ALLOWED = ["city", "slug", "name", "address", "venue", "active"];

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
        `UPDATE locations SET ${set.join(", ")} WHERE id = $${pi}`,
        vals
      );

      if (!rowCount) return res.status(404).json({ error: "Nie znaleziono lokalizacji" });
      return res.status(200).json({ success: true });
    }

    // DELETE — usuń lokalizację (tylko jeśli nie ma grup)
    if (method === "DELETE") {
      const { rows: gc } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM groups WHERE location_id = $1",
        [id]
      );
      if (gc[0].c > 0) return res.status(400).json({ error: "Nie można usunąć: lokalizacja ma grupy." });

      const { rowCount } = await pool.query("DELETE FROM locations WHERE id = $1", [id]);
      if (!rowCount) return res.status(404).json({ error: "Nie znaleziono lokalizacji" });

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    // slug bywa unikalny — tu będzie czytelniejszy błąd
    if (String(e.message || "").toLowerCase().includes("duplicate")) {
      return res.status(400).json({ error: "Slug już istnieje. Wybierz inny." });
    }
    return res.status(500).json({ error: e.message });
  }
};
