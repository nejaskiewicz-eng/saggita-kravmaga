// api/catalog.js  — Funkcja #1 (łączy schedule + prices)
// GET /api/schedule → grafik lokalizacje→grupy→terminy
// GET /api/prices   → plany cennikowe
// Routing przez query param ?_r=prices (vercel.json rewrite dodaje go)
const { getPool } = require('./_lib/db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const pool = getPool();

  // ── PRICES: /api/prices → ?_r=prices ────────────────────────
  if (req.query._r === 'prices') {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, category, price, signup_fee, months, description
         FROM price_plans WHERE active = true ORDER BY category, price`
      );
      return res.status(200).json(rows);
    } catch (e) {
      console.error('[prices]', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── SCHEDULE: /api/schedule (domyślnie) ──────────────────────
  try {
    const { rows: locs } = await pool.query(
      `SELECT id, city, name, slug, address FROM locations WHERE active = true ORDER BY sort_order, city`
    );

    // UWAGA: Aktualizacja! Liczymy nowe rejestracje ORAZ kursantów przeniesionych z legacy
    const { rows: groups } = await pool.query(`
      SELECT
        g.id, g.location_id, g.name, g.category, g.age_range,
        g.max_capacity, g.notes, g.active,
        (
          COALESCE(COUNT(DISTINCT r.id) FILTER (
            WHERE r.status NOT IN ('cancelled') AND r.is_waitlist = false
          ), 0) +
          COALESCE(COUNT(DISTINCT sg.student_id) FILTER (
            WHERE sg.active = true
          ), 0)
        )::int AS registered
      FROM groups g
      LEFT JOIN registrations r ON r.group_id = g.id
      LEFT JOIN student_groups sg ON sg.group_id = g.id
      WHERE g.active = true
      GROUP BY g.id
      ORDER BY g.name
    `);

    const { rows: scheds } = await pool.query(`
      SELECT id, group_id, day_of_week, day_name, time_start, time_end, time_label, address
      FROM schedules WHERE active = true ORDER BY day_of_week, time_start
    `);

    const result = locs.map(loc => {
      const locGroups = groups
        .filter(g => g.location_id === loc.id)
        .map(g => ({
          ...g,
          available: Math.max(0, (g.max_capacity || 0) - g.registered),
          schedules: scheds.filter(s => s.group_id === g.id),
        }));
      return { ...loc, groups: locGroups };
    });

    return res.status(200).json(result);
  } catch (e) {
    console.error('[schedule]', e);
    return res.status(500).json({ error: e.message });
  }
};