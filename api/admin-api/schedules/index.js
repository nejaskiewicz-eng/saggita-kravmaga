// api/admin-api/schedules/index.js
// GET (public, bez auth)  → struktura pod "Zapisz się" (locations -> groups -> schedules)
// GET (admin, z auth)     → lista terminów (płaska) do panelu
// POST/PATCH/DELETE       → tylko admin (auth)

const { getPool } = require('../../_lib/db');
const { requireAuth } = require('../../_lib/auth');

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
  return String(t).slice(0, 5);
}

function computeTimeLabel(time_start, time_end) {
  const ts = hhmm(time_start);
  const te = hhmm(time_end);
  if (ts && te) return `${ts}–${te}`;
  if (ts && !te) return `${ts}`;
  return 'Termin do ustalenia';
}

function hasAuthHeader(req) {
  const h = req.headers?.authorization;
  return !!(h && String(h).trim().length);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const pool = getPool();
  const { id } = req.query;

  // ─────────────────────────────────────────────────────────────
  // GET
  // ─────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // 1) ADMIN: jeśli jest Authorization → wymagamy auth i zwracamy płaską listę do panelu
    if (hasAuthHeader(req)) {
      try { requireAuth(req); }
      catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

      try {
        const { rows } = await pool.query(`
          SELECT s.*, g.name AS group_name, l.city, l.name AS location_name
          FROM schedules s
          LEFT JOIN groups g ON g.id = s.group_id
          LEFT JOIN locations l ON l.id = g.location_id
          ORDER BY l.city, g.name, s.day_of_week, s.time_start
        `);
        return res.status(200).json(rows);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // 2) PUBLIC: bez Authorization → dane dla strony "Zapisz się"
    try {
      const { rows: locations } = await pool.query(`
        SELECT id, city, name, slug, address
        FROM locations
        ORDER BY city ASC
      `);

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

      const locMap = new Map();
      for (const l of locations) locMap.set(l.id, { ...l, groups: [] });

      const groupMap = new Map();
      for (const g of groups) {
        const maxCap = g.max_capacity != null ? Number(g.max_capacity) : null;
        const reg = Number(g.registered || 0);
        const available = maxCap == null ? null : Math.max(0, maxCap - reg);

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
          available,
          schedules: [],
        };

        groupMap.set(g.id, groupObj);

        const loc = locMap.get(g.location_id);
        if (loc) loc.groups.push(groupObj);
      }

      for (const s of schedules) {
        if (s.active === false) continue;
        const g = groupMap.get(s.group_id);
        if (!g) continue;

        const dayName = s.day_name || PL_DAYS[s.day_of_week] || '—';
        const timeLabel = s.time_label || computeTimeLabel(s.time_start, s.time_end);

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

      for (const g of groupMap.values()) {
        g.schedules.sort((a, b) => {
          const d = (a.day_of_week ?? 99) - (b.day_of_week ?? 99);
          if (d !== 0) return d;
          return String(a.time_start || '').localeCompare(String(b.time_start || ''));
        });
      }

      const result = Array.from(locMap.values()).map(loc => ({
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
      return res.status(500).json({ error: e.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN ONLY BELOW
  // ─────────────────────────────────────────────────────────────
  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  // ── POST nowy termin ───────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const b = req.body || {};
      if (!b.group_id) return res.status(400).json({ error: 'Brak group_id.' });

      const day_name = b.day_name || (b.day_of_week != null ? PL_DAYS[b.day_of_week] : null);
      const time_label = b.time_label || computeTimeLabel(b.time_start, b.time_end);

      const { rows: [s] } = await pool.query(
        `INSERT INTO schedules (group_id, day_of_week, day_name, time_start, time_end, time_label, address, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          b.group_id,
          b.day_of_week,
          day_name,
          b.time_start || null,
          b.time_end || null,
          time_label,
          b.address || null,
          b.active !== false
        ]
      );

      return res.status(201).json(s);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH edycja ───────────────────────────────────────────────
  if (req.method === 'PATCH' && id) {
    try {
      const b = req.body || {};
      const ALLOWED = ['group_id','day_of_week','day_name','time_start','time_end','time_label','address','active'];

      if ('day_of_week' in b && !('day_name' in b)) {
        b.day_name = PL_DAYS[b.day_of_week] || null;
      }
      if (('time_start' in b || 'time_end' in b) && !('time_label' in b)) {
        b.time_label = computeTimeLabel(b.time_start, b.time_end);
      }

      const set = [];
      const vals = [];
      let pi = 1;

      for (const key of ALLOWED) {
        if (key in b) {
          set.push(`${key}=$${pi++}`);
          vals.push(b[key]);
        }
      }

      if (!set.length) return res.status(400).json({ error: 'Brak pól.' });

      vals.push(id);

      const { rowCount } = await pool.query(
        `UPDATE schedules SET ${set.join(',')} WHERE id=$${pi}`,
        vals
      );

      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ─────────────────────────────────────────────────────
  if (req.method === 'DELETE' && id) {
    try {
      const { rowCount } = await pool.query(`DELETE FROM schedules WHERE id=$1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Nie znaleziono.' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
