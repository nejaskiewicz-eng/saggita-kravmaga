const { getPool } = require("../../../_db");

module.exports = async (req, res) => {
  const pool = getPool();
  const { id } = req.query;
  const method = req.method;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (method === "OPTIONS") return res.status(204).end();

  try {
    if (method === "GET") {
      const { rows } = await pool.query(
        `
        SELECT r.id, r.first_name, r.last_name, r.email, r.phone,
               r.status, r.payment_status, r.is_waitlist, r.created_at
        FROM registrations r
        WHERE r.group_id = $1
        ORDER BY r.created_at DESC
        `,
        [id]
      );
      return res.status(200).json({ rows });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
