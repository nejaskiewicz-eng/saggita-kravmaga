// api/admin-api/schedules/index.js  — Funkcja #11
// GET    /api/admin-api/schedules           → lista terminów
// POST   /api/admin-api/schedules           → nowy termin
// PATCH  /api/admin-api/schedules?id=X      → edycja terminu
// DELETE /api/admin-api/schedules?id=X      → usunięcie terminu

const { getPool } = require('../../_lib/db');
const { requireAuth } = require('../../_lib/auth');

const DAY_NAMES = ['niedziela','poniedziałek','wtorek','środa','czwartek','piątek','sobota'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const { id } = req.query;

  // ── GET lista ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(`
        SELECT s.*, g.name AS group_name, l.city, l.name AS location_name
        FROM schedules s
        LEFT JOIN groups g ON g.id = s.group_id
        LEFT JOIN locations l ON l.id = g.location_id
        ORDER BY l.city, g.name, s.day_of_week, s.time_start
      `);

      // Zwracaj tablicę, nie { rows }, bo frontendowi łatwiej to konsumować
      return res.status(200).json(rows);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST nowy termin ───────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const b = req.body || {};
      if (!b.group_id) return res.status(400).json({ error: 'Brak group_id.' });

      const day_name = b.day_name || (b.day_of_week != null ? DAY_NAMES[b.day_of_week] : null);
      const time_label = b.time_label ||
        (b.time_start ? `${b.time_start}${b.time_end ? `–${b.time_end}` : ''}` : null);

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

      // Automatycznie wylicz day_name / time_label jeśli brakuje
      if ('day_of_week' in b && !('day_name' in b)) {
        b.day_name = DAY_NAMES[b.day_of_week] || null;
      }
      if (('time_start' in b || 'time_end' in b) && !('time_label' in b)) {
        const ts = b.time_start || '';
        const te = b.time_end || '';
        b.time_label = ts ? `${ts}${te ? `–${te}` : ''}` : null;
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
