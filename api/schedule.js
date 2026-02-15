const { getPool } = require("./_db");

const DAY_PL = ["", "Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota", "Niedziela"];

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

    const [{ rows: locs }, { rows: grps }, { rows: scheds }, { rows: cnts }] = await Promise.all([
      pool.query("SELECT * FROM locations WHERE active = true ORDER BY id"),
      pool.query("SELECT * FROM groups WHERE active = true ORDER BY location_id, id"),
      pool.query("SELECT * FROM schedules WHERE active = true ORDER BY group_id, day_of_week NULLS LAST, time_start"),
      pool.query(`
        SELECT group_id, COUNT(*) AS cnt
        FROM registrations
        WHERE status NOT IN ('cancelled') AND is_waitlist = false
        GROUP BY group_id
      `),
    ]);

    const cntMap = {};
    cnts.forEach((c) => (cntMap[c.group_id] = parseInt(c.cnt, 10)));

    const data = locs.map((loc) => ({
      ...loc,
      groups: grps
        .filter((g) => g.location_id === loc.id)
        .map((g) => ({
          ...g,
          registered: cntMap[g.id] || 0,
          available: Math.max(0, g.max_capacity - (cntMap[g.id] || 0)),
          schedules: scheds
            .filter((s) => s.group_id === g.id)
            .map((s) => ({
              ...s,
              day_name: s.day_of_week ? DAY_PL[s.day_of_week] : null,
              time_label:
                s.time_start && s.time_end
                  ? `${String(s.time_start).slice(0, 5)} – ${String(s.time_end).slice(0, 5)}`
                  : null,
            })),
        })),
    }));

    return res.status(200).json(data);
  } catch (e) {
    console.error("[schedule]", e);
    return res.status(500).json({ error: "Błąd serwera. Spróbuj ponownie za chwilę." });
  }
};
