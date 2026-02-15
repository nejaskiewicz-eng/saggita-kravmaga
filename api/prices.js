const { getPool } = require("./_db");

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
    const { rows } = await pool.query("SELECT * FROM price_plans WHERE active = true ORDER BY sort_order");
    return res.status(200).json(rows);
  } catch (e) {
    console.error("[prices]", e);
    return res.status(500).json({ error: "Błąd serwera. Spróbuj ponownie za chwilę." });
  }
};
