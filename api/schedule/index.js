// /api/schedule/index.js
// Publiczny endpoint dla strony "Zapisz się"
// Zwraca: [{ id, city, name, slug, address, groups: [{... , schedules:[...]}] }]

const { getPool } = require('../admin-api/_lib/db');

const PL_DAYS = {
  1: 'Poniedziałek',
  2: 'Wtorek',
  3: 'Środa',
  4: 'Czwartek',
  5: 'Piątek',
  6: 'Sobota',
  0: 'Niedziela',
  7: 'Niedziela',
};

function hhmm(t) {
  if (!t) return null;
  // postgres potrafi zwrócić "18:30:00" lub "18:30"
  return String(t).slice(0, 5);
}

function computeTimeLabel(time_start, time_end) {
  const ts = hhmm(time_start);
  const te = hhmm(time_end);
  if (ts && te) return `${ts}–${te}`;
  if (ts && !te) return `${ts}`;
  return 'Termin do ustalenia';
}

module.exports = async (req, res) => {
  // CORS (żeby nie było niespodzianek)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const pool = getPool();

    // 1) Lokacje
    const { rows: locations } = await pool.query(`
      SELECT id, city, name, slug, address
      FROM locations
      ORDER BY city ASC
    `);

    // 2) Grupy + policzone zapisy (registered/available)
    // Zakładam, że registrations ma group_id (bo u Ciebie w JSON tak jest).
    // Jeśli masz "status" i chcesz filtrować np. tylko potwierdzone, to dopisz warunek w COUNT.
    const { rows: groups } = await pool.query(`
      SELECT
        g.id,
        g.location_id,
        g.name,
        g.category,
        g.age_range,
        g.max_capacity,
        g.notes,
        g.active,
        COALESCE(COUNT(r.id), 0)::int AS registered
      FROM groups g
      LEFT JOIN registrations r ON r.group_id = g.id
      GROUP BY g.id
      ORDER BY g.location_id ASC, g.name ASC
    `);

    // 3) Terminy
    const { rows: schedules } = await pool.query(`
      SELECT
        id,
        group_id,
        day_of_week,
        day_name,
        time_start,
        time_end,
        time_label,
        address,
        active
      FROM schedules
      ORDER BY day_of_week ASC, time_start ASC
    `);

    // Mapy do składania struktury
    const locMap = new Map();
    for (const l of locations) {
      locMap.set(l.id, { ...l, groups: [] });
    }

    const groupMap = new Map();
    for (const g of groups) {
      const maxCap = g.max_capacity != null ? Number(g.max_capacity) : null;
      const reg = Number(g.registered || 0);

      const available =
        maxCap == null ? null : Math.max(0, maxCap - reg);

      const groupObj = {
        id: g.id,
        location_id: g.location_id,
        name: g.name,
        category: g.category,
        age_range: g.age_range,
        max_capacity: maxCap,
        notes: g.notes,
        active: g.active,
        registered: reg,
        available: available,
        schedules: [],
      };

      groupMap.set(g.id, groupObj);

      const loc = locMap.get(g.location_id);
      if (loc) loc.groups.push(groupObj);
    }

    // Doklej terminy do grup
    for (const s of schedules) {
      if (s.active === false) continue;

      const g = groupMap.get(s.group_id);
      if (!g) continue;

      const dayName =
        s.day_name ||
        PL_DAYS[s.day_of_week] ||
        '—';

      const timeLabel =
        s.time_label ||
        computeTimeLabel(s.time_start, s.time_end);

      g.schedules.push({
        id: s.id,
        group_id: s.group_id,
        day_of_week: s.day_of_week,
        day_name: dayName,
        time_start: s.time_start,
        time_end: s.time_end,
        time_label: timeLabel,
        address: s.address || null,
      });
    }

    // Sortowanie wewnątrz grup
    for (const g of groupMap.values()) {
      g.schedules.sort((a, b) => {
        const d = (a.day_of_week ?? 99) - (b.day_of_week ?? 99);
        if (d !== 0) return d;
        return String(a.time_start || '').localeCompare(String(b.time_start || ''));
      });
    }

    // Final: tylko lokacje, które istnieją, z grupami aktywnymi
    const result = Array.from(locMap.values())
      .map(loc => ({
        ...loc,
        groups: (loc.groups || [])
          .filter(gr => gr && gr.active !== false)
          .map(gr => ({
            ...gr,
            schedules: gr.schedules || [],
          })),
      }));

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
