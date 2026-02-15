const { getPool } = require("../_db");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const pool = getPool();
    const ref = String(req.query.ref || "").trim().toUpperCase();

    const { rows: [reg] } = await pool.query(`
      SELECT r.id, r.first_name, r.last_name, r.payment_ref,
             r.payment_status, r.status, r.total_amount,
             r.is_waitlist, r.created_at, r.start_date,
             g.name AS group_name, l.city, l.address AS location_address,
             p.name AS plan_name
      FROM registrations r
      LEFT JOIN groups g ON r.group_id = g.id
      LEFT JOIN locations l ON g.location_id = l.id
      LEFT JOIN price_plans p ON r.price_plan_id = p.id
      WHERE r.payment_ref = $1
    `, [ref]);

    if (!reg) return res.status(404).json({ error: "Nie znaleziono zapisu o podanym kodzie" });
    return res.status(200).json(reg);
  } catch (e) {
    console.error("[status]", e);
    return res.status(500).json({ error: "Błąd serwera. Spróbuj ponownie za chwilę." });
  }
};
