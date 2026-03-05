// api/register.js  — Funkcja #3
// POST /api/register → zapis kursanta, zwraca dane płatności
const { getPool } = require('./_lib/db');
const { sendMail, mailAdmin, mailWaitlist, mailKursant } = require('./_lib/mail');

const BANK_ACCOUNT = process.env.BANK_ACCOUNT || '21 1140 2004 0000 3902 3890 8895';
const BANK_NAME = process.env.BANK_NAME || 'Akademia Obrony Saggita';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'biuro@akademiaobrony.pl';

function genRef() {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `KM-${ts}-${rnd}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const pool = getPool();
    const b = req.body || {};

    // Walidacja
    if (!b.first_name || !b.last_name) return res.status(400).json({ error: 'Imię i nazwisko są wymagane.' });
    if (!b.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return res.status(400).json({ error: 'Nieprawidłowy adres e-mail.' });
    if (!b.phone) return res.status(400).json({ error: 'Numer telefonu jest wymagany.' });
    if (!b.group_id) return res.status(400).json({ error: 'Wybierz grupę.' });

    // Pobierz dane grupy i planu
    const { rows: [group] } = await pool.query(
      `SELECT g.id, g.name, g.max_capacity, g.category, g.location_id,
              l.city, l.name AS location_name
       FROM groups g LEFT JOIN locations l ON l.id = g.location_id
       WHERE g.id = $1`,
      [b.group_id]
    );
    if (!group) return res.status(404).json({ error: 'Nie znaleziono grupy.' });

    // Sprawdź pojemność
    const { rows: [cap] } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM registrations
       WHERE group_id = $1 AND status NOT IN ('cancelled') AND is_waitlist = false`,
      [b.group_id]
    );
    const is_waitlist = cap.cnt >= (group.max_capacity || 9999);

    // Pobierz cennik
    let total_amount = 0;
    let plan_name = null;
    let planMonths = 1;
    let planRow = null;

    // Jeśli osoba ma karnet, nie płaci
    if (b.has_membership) {
      total_amount = 0;
      plan_name = 'Posiadacz karnetu miesięcznego';
    } else if (b.price_plan_id) {
      const { rows: [plan] } = await pool.query(
        `SELECT id, name, price, signup_fee, months FROM price_plans WHERE id = $1 AND active = true`,
        [b.price_plan_id]
      );
      planRow = plan;
      if (plan) {
        const fee = b.is_new ? parseFloat(plan.signup_fee || 0) : 0;
        const planPrice = parseFloat(plan.price || 0);
        const planMaxMonths = parseInt(plan.months || 1);
        // Dla planów szkolnych (price_per_month * months): jeśli front przekazał months_selected, przelicz
        const monthsSelected = parseInt(b.months_selected || b.months_count || 0);
        if (monthsSelected > 0 && monthsSelected <= planMaxMonths && planMaxMonths > 1) {
          // Stawka miesięczna = plan.price / plan.months
          const monthlyRate = planPrice / planMaxMonths;
          total_amount = Math.round(monthlyRate * monthsSelected) + fee;
          planMonths = monthsSelected;
        } else {
          total_amount = planPrice + fee;
          planMonths = planMaxMonths;
        }
        plan_name = plan.name;
      }
    }

    const payment_ref = genRef();
    const payment_status = b.has_membership ? 'waived' : 'unpaid';

    // Zapisz
    const { rows: [reg] } = await pool.query(`
      INSERT INTO registrations (
        first_name, last_name, email, phone, birth_year, is_new,
        group_id, schedule_id, price_plan_id, location_id,
        start_date, preferred_time,
        is_waitlist, status, payment_status, payment_method,
        payment_ref, total_amount, source, consent_data, consent_rules, has_membership, signature_data
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,
        $11,$12,
        $13,'new',$14,$15,
        $16,$17,'web',$18,$19,$20,$21
      ) RETURNING id, payment_ref, total_amount, is_waitlist, email`,
      [
        b.first_name.trim(), b.last_name.trim(), b.email.trim(), b.phone.trim(),
        b.birth_year || null, b.is_new !== false,
        b.group_id, b.schedule_id || null, b.price_plan_id || null, group.location_id,
        b.start_date || null, b.preferred_time || null,
        is_waitlist, payment_status, b.payment_method || 'transfer',
        payment_ref, total_amount, b.consent_data || false, b.consent_rules || false,
        b.has_membership || false, b.sig1 || null,
      ]
    );

    // Tryb płatności przekazany z frontendu
    const payment_mode = b.payment_mode || null;          // 'full' | 'monthly' | null
    const months = parseInt(b.months || planMonths || 1);
    const signup_fee = b.is_new ? parseFloat(planRow?.signup_fee || 0) : 0;
    const base_amount = total_amount - signup_fee;
    const monthly_rate = b.monthly_rate
      ? parseFloat(b.monthly_rate)
      : (months > 1 ? Math.round(base_amount / months) : base_amount);
    const reminders = b.reminders !== false;

    const mailData = {
      first_name: b.first_name, last_name: b.last_name,
      email: b.email, phone: b.phone,
      payment_ref, group_name: group.name, city: group.city,
      total_amount, plan_name, is_waitlist,
      bank_account: BANK_ACCOUNT, bank_name: BANK_NAME,
      payment_mode, months, monthly_rate, signup_fee, reminders,
      doc_url: '', online_url: '',
    };

    const mails = [
      sendMail({ to: ADMIN_EMAIL, ...mailAdmin({ ...mailData, payment_mode, months, monthly_rate }) }),
    ];

    // Mail do kursanta wysyłamy dopiero po kliknięciu zielonego przycisku (action.js).
    // Tu wysyłamy tylko mail na listę rezerwową (bo ci nie mają kroku płatności).
    if (is_waitlist) {
      mails.push(sendMail({ to: b.email, ...mailWaitlist(mailData) }));
    }

    Promise.all(mails).catch(e => console.error('[register/mail]', e));

    return res.status(201).json({
      id: reg.id,
      payment_ref: reg.payment_ref,
      total_amount: reg.total_amount,
      is_waitlist: reg.is_waitlist,
      email: reg.email,
      bank_account: BANK_ACCOUNT,
      bank_name: BANK_NAME,
      transfer_title: `${payment_ref} — ${b.first_name} ${b.last_name}`,
    });

  } catch (e) {
    console.error('[register]', e);
    return res.status(500).json({ error: e.message });
  }
};
