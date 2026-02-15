const { getPool } = require("./_db");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function genRef() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "KM";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const pool = getPool();
    const body = req.body || {};

    const {
      first_name, last_name, email, phone,
      birth_year, is_new = true,
      group_id, schedule_id, price_plan_id,
      start_date, payment_method = "transfer",
      consent_data, consent_rules,
      preferred_time, is_waitlist = false,
    } = body;

    if (!first_name?.trim() || !last_name?.trim()) return res.status(400).json({ error: "Podaj imię i nazwisko" });
    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Podaj prawidłowy adres email" });
    if (!phone?.trim()) return res.status(400).json({ error: "Podaj numer telefonu" });
    if (!consent_data || !consent_rules) return res.status(400).json({ error: "Wymagana zgoda na przetwarzanie danych i akceptacja regulaminu" });

    let total_amount = null;

    if (price_plan_id) {
      const { rows: [p] } = await pool.query(
        "SELECT * FROM price_plans WHERE id = $1 AND active = true",
        [price_plan_id]
      );
      if (p) total_amount = parseFloat(p.price) + (is_new ? parseFloat(p.signup_fee || 0) : 0);
    }

    let finalWaitlist = Boolean(is_waitlist);

    if (group_id && !finalWaitlist) {
      const { rows: [grp] } = await pool.query("SELECT max_capacity, notes FROM groups WHERE id = $1", [group_id]);

      if (grp?.notes?.toLowerCase().includes("zamknięty")) {
        finalWaitlist = true;
      } else if (grp) {
        const { rows: [{ cnt }] } = await pool.query(
          "SELECT COUNT(*) AS cnt FROM registrations WHERE group_id = $1 AND status NOT IN ('cancelled') AND is_waitlist = false",
          [group_id]
        );
        if (parseInt(cnt, 10) >= grp.max_capacity) finalWaitlist = true;
      }
    }

    let ref;
    for (let i = 0; i < 10; i++) {
      ref = genRef();
      const { rows } = await pool.query("SELECT id FROM registrations WHERE payment_ref = $1", [ref]);
      if (!rows.length) break;
    }

    const { rows: [reg] } = await pool.query(`
      INSERT INTO registrations (
        first_name, last_name, email, phone, birth_year, is_new,
        group_id, schedule_id, price_plan_id, start_date,
        payment_method, total_amount, payment_ref,
        consent_data, consent_rules, is_waitlist, preferred_time,
        status
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,
        $11,$12,$13,
        $14,$15,$16,$17,
        $18
      )
      RETURNING id, payment_ref, total_amount, is_waitlist, status
    `, [
      first_name.trim(), last_name.trim(), email.trim().toLowerCase(), phone.trim(),
      birth_year || null, Boolean(is_new),
      group_id || null, schedule_id || null, price_plan_id || null,
      start_date || null,
      payment_method, total_amount, ref,
      Boolean(consent_data), Boolean(consent_rules),
      finalWaitlist, preferred_time || null,
      finalWaitlist ? "waitlist" : "new",
    ]);

    return res.status(201).json({
      success: true,
      id: reg.id,
      payment_ref: reg.payment_ref,
      total_amount: reg.total_amount,
      is_waitlist: reg.is_waitlist,
      status: reg.status,
      bank_account: "21 1140 2004 0000 3902 3890 8895",
      bank_name: "AKADEMIA OBRONY SAGGITA",
      transfer_title: `Krav Maga ${first_name.trim()} ${last_name.trim()} ${reg.payment_ref}`,
      address: "Pl. Św. Małgorzaty 1-2, 58-100 Świdnica",
      phone: "510 930 460",
      email_contact: "biuro@akademiaobrony.pl",
    });
  } catch (e) {
    console.error("[register]", e);
    return res.status(500).json({ error: "Błąd serwera. Spróbuj ponownie za chwilę." });
  }
};
