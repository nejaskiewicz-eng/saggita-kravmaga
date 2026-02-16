const { getPool } = require("../../_db");

module.exports = async (req, res) => {
  const pool = getPool();

  const method = req.method;

  const auth = req.headers.authorization || "";
  if (!auth) return res.status(401).json({ error: "Brak autoryzacji" });

  try {

    // LISTA KURSANTÓW
    if (method === "GET") {
      const { rows } = await pool.query(`
        SELECT r.id, r.first_name, r.last_name, r.email, r.phone,
               r.status, r.payment_status, r.created_at,
               g.name AS group_name, l.city
        FROM registrations r
        LEFT JOIN groups g ON r.group_id = g.id
        LEFT JOIN locations l ON g.location_id = l.id
        WHERE r.source = 'admin'
        ORDER BY r.created_at DESC
      `);

      return res.status(200).json({ rows });
    }

    // DODAJ KURSANTA
    if (method === "POST") {
      const b = req.body || {};

      const { rows: [p] } = await pool.query(`
        INSERT INTO registrations
          (first_name, last_name, email, phone, source, status, created_at)
        VALUES
          ($1,$2,$3,$4,'admin','confirmed', NOW())
        RETURNING id
      `, [
        b.first_name,
        b.last_name,
        b.email || null,
        b.phone || null
      ]);

      return res.status(201).json({ success: true, id: p.id });
    }

    return res.status(404).json({ error: "Nie znaleziono ścieżki" });

  } catch (e) {
    return res.status(500).json({ error: "Błąd serwera", detail: e.message });
  }
};
