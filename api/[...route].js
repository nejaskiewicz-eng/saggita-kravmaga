// api/[...route].js
import crypto from "crypto";
import { Client } from "pg";

/**
 * WYMAGANE ENV (Vercel -> Project -> Settings -> Environment Variables)
 * - DATABASE_URL (Neon)
 * - RESEND_API_KEY (opcjonalnie na start, ale potrzebne do maili)
 * - MAIL_FROM (np. onboarding@resend.dev)
 */

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function notFound(res) {
  return json(res, 404, { error: "Not found" });
}

function methodNotAllowed(res) {
  return json(res, 405, { error: "Method not allowed" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk) => (buf += chunk));
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function dbQuery(text, params = []) {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) throw new Error("Brak DATABASE_URL w zmiennych środowiskowych.");

  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    await client.end();
  }
}

function safeUpper(s) {
  return String(s || "").toUpperCase();
}

function makePaymentRef() {
  // krótki kod jak w screenie: KMJDV4WX
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "KM";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function sendResendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;

  if (!key) throw new Error("Brak RESEND_API_KEY w zmiennych środowiskowych.");
  if (!from) throw new Error("Brak MAIL_FROM w zmiennych środowiskowych.");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      text,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.message || "Resend error";
    throw new Error(msg);
  }
  return data;
}

/**
 * Minimalny „dokument płatniczy” jako HTML -> PDF bez bibliotek jest trudny.
 * Dlatego robimy na start wersję „PDF jako prosty plik tekstowy w PDF-like” nie przejdzie.
 *
 * Rozsądny standard: dodać zależność "pdfkit" i generować prawdziwy PDF.
 * Jeśli chcesz – dam Ci od razu gotowy payment-document na pdfkit,
 * ale potrzebujesz dopisać dependency w package.json.
 *
 * NA TERAZ: zwracamy HTML jako .pdf (większość przeglądarek to otworzy, ale to nie jest idealne).
 * Jeśli chcesz „prawdziwy PDF”, napisz: "robimy pdfkit" i dam Ci gotowy package.json + kod.
 */
function buildPaymentDocHTML(reg) {
  const amount = Number(reg.total_amount || 0).toFixed(2);
  const issueDate = todayISO();

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>Dokument płatniczy ${reg.payment_ref}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;margin:28px;color:#111}
  h1{font-size:18px;margin:0 0 10px}
  .muted{color:#555;font-size:12px}
  .box{border:1px solid #ddd;padding:14px;margin-top:14px}
  .row{margin:6px 0}
  .lbl{font-weight:bold}
</style>
</head>
<body>
  <h1>Dokument płatniczy</h1>
  <div class="muted">Numer: ${reg.payment_ref} · Data wystawienia: ${issueDate}</div>

  <div class="box">
    <div class="row"><span class="lbl">Odbiorca:</span> Akademia Obrony Saggita</div>
    <div class="row"><span class="lbl">Kwota:</span> ${amount} PLN</div>
    <div class="row"><span class="lbl">Tytuł:</span> ${reg.transfer_title || `Krav Maga ${reg.first_name} ${reg.last_name} ${reg.payment_ref}`}</div>
    <div class="row"><span class="lbl">Płatnik:</span> ${reg.first_name} ${reg.last_name} · ${reg.email}</div>
  </div>

  <div class="box">
    <div class="row"><span class="lbl">Informacja:</span> Rezerwacja ważna 3 dni robocze od wygenerowania dokumentu.</div>
  </div>

  <p class="muted" style="margin-top:16px">
    W razie pytań: biuro@akademiaobrony.pl · 510 930 460
  </p>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname; // np. /api/schedule
    const sub = path.replace(/^\/api\/?/, ""); // schedule, prices, register, registration/action, payment-document

    // routing
    if (req.method === "GET" && (sub === "" || sub === "/")) {
      return json(res, 200, { ok: true, api: "saggita" });
    }

    // GET /api/schedule
    if (req.method === "GET" && sub === "schedule") {
      // Tu zakładam, że masz tabelę/VIEW, z której wcześniej zwracała funkcja schedule.js.
      // Jeśli masz już gotowy SQL w starym schedule.js, to wkleimy go tu.
      // Na teraz: czytamy z tabeli locations + groups + schedules (typowy układ).
      // Jeśli nazwy masz inne, podeślij, dopasuję.
      const locs = await dbQuery(`SELECT id, city FROM locations ORDER BY id ASC`);
      const groups = await dbQuery(`SELECT * FROM groups ORDER BY id ASC`);
      const scheds = await dbQuery(`SELECT * FROM schedules ORDER BY id ASC`);

      const byLoc = new Map();
      locs.rows.forEach((l) => byLoc.set(l.id, { id: l.id, city: l.city, groups: [] }));

      const groupById = new Map();
      groups.rows.forEach((g) => {
        const item = {
          ...g,
          schedules: [],
        };
        groupById.set(g.id, item);
        const loc = byLoc.get(g.location_id);
        if (loc) loc.groups.push(item);
      });

      scheds.rows.forEach((s) => {
        const g = groupById.get(s.group_id);
        if (g) g.schedules.push(s);
      });

      return json(res, 200, Array.from(byLoc.values()));
    }

    // GET /api/prices
    if (req.method === "GET" && sub === "prices") {
      const r = await dbQuery(`SELECT * FROM price_plans ORDER BY id ASC`);
      return json(res, 200, r.rows);
    }

    // POST /api/register
    if (req.method === "POST" && sub === "register") {
      const body = await readBody(req);

      const required = ["first_name", "last_name", "email", "phone", "group_id"];
      for (const k of required) {
        if (!body?.[k]) return json(res, 400, { error: `Brak pola: ${k}` });
      }

      const payment_ref = makePaymentRef();

      // total_amount – jeśli masz logikę w backendzie (np. price_plan + wpisowe),
      // to najlepiej policzyć tu. Na start bierzemy z price_plan.
      let total_amount = null;
      let transfer_title = `Krav Maga ${body.first_name} ${body.last_name} ${payment_ref}`;

      if (body.price_plan_id) {
        const pr = await dbQuery(`SELECT * FROM price_plans WHERE id=$1`, [body.price_plan_id]);
        const plan = pr.rows[0];
        if (plan) {
          const price = Number(plan.price || 0);
          const fee = body.is_new ? Number(plan.signup_fee || 0) : 0;
          total_amount = price + fee;
        }
      }

      // Dane przelewu – ustaw według swoich stałych
      const bank_account = "21 1140 2004 0000 3902 3890 8895";
      const bank_name = "AKADEMIA OBRONY SAGGITA";

      // insert
      const ins = await dbQuery(
        `INSERT INTO registrations
          (group_id, schedule_id, price_plan_id, first_name, last_name, email, phone, birth_year, is_new,
           start_date, payment_method, total_amount, payment_ref, payment_status, status, is_waitlist,
           preferred_time, consent_data, consent_rules, source)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,
           $10,$11,$12,$13,$14,$15,$16,
           $17,$18,$19,$20)
         RETURNING id, payment_ref, total_amount, is_waitlist, email`,
        [
          body.group_id,
          body.schedule_id ?? null,
          body.price_plan_id ?? null,
          body.first_name,
          body.last_name,
          body.email,
          body.phone,
          body.birth_year ?? null,
          !!body.is_new,
          body.start_date ?? null,
          body.payment_method ?? "transfer",
          total_amount,
          payment_ref,
          "unpaid",
          "new",
          !!body.is_waitlist,
          body.preferred_time ?? null,
          !!body.consent_data,
          !!body.consent_rules,
          body.source ?? "web",
        ]
      );

      const row = ins.rows[0];

      return json(res, 200, {
        ok: true,
        payment_ref: row.payment_ref,
        total_amount: row.total_amount,
        is_waitlist: row.is_waitlist,
        email: row.email,
        bank_account,
        bank_name,
        transfer_title,
      });
    }

    // POST /api/registration/action
    if (req.method === "POST" && sub === "registration/action") {
      const body = await readBody(req);
      const payment_ref = body?.payment_ref;
      const action = body?.action;

      if (!payment_ref || !action) return json(res, 400, { error: "Brak payment_ref lub action." });

      const r = await dbQuery(`SELECT * FROM registrations WHERE payment_ref=$1 LIMIT 1`, [payment_ref]);
      const reg = r.rows[0];
      if (!reg) return json(res, 404, { error: "Nie znaleziono zapisu." });

      // log akcji (jeśli masz tabelę, jeśli nie – pomijamy)
      // await dbQuery(`INSERT INTO registration_actions(payment_ref, action, created_at) VALUES($1,$2,NOW())`, [payment_ref, action]).catch(()=>{});

      // Mail treść zależna od akcji:
      // - pay_online => potwierdzenie zapisania na szkolenie
      // - download_doc => potwierdzenie rezerwacji + 3 dni robocze na opłatę
      const fullName = `${reg.first_name} ${reg.last_name}`.trim();

      let subject = "";
      let html = "";
      let text = "";

      if (action === "pay_online") {
        subject = `Potwierdzenie zapisu — ${payment_ref}`;
        html = `
          <p>Cześć ${reg.first_name},</p>
          <p>Dziękujemy za zapis. Twoje zgłoszenie zostało przyjęte.</p>
          <p><strong>Kod zgłoszenia:</strong> ${payment_ref}</p>
          <p>Jeśli wybrałeś/aś płatność online — w kolejnym kroku podepniemy bramkę płatności (na razie przycisk jest w wersji testowej).</p>
          <p>W razie pytań: biuro@akademiaobrony.pl · 510 930 460</p>
        `;
        text = `Cześć ${reg.first_name}, dziękujemy za zapis. Kod: ${payment_ref}.`;
      } else if (action === "download_doc") {
        subject = `Rezerwacja miejsca — ${payment_ref} (3 dni robocze na opłatę)`;
        html = `
          <p>Cześć ${reg.first_name},</p>
          <p>Twoja rezerwacja została przyjęta.</p>
          <p><strong>Kod rezerwacji:</strong> ${payment_ref}</p>
          <p>Masz <strong>3 dni robocze</strong> na opłatę. Po tym czasie rezerwacja przepada.</p>
          <p>Dokument płatniczy możesz pobrać z ekranu potwierdzenia na stronie.</p>
          <p>W razie pytań: biuro@akademiaobrony.pl · 510 930 460</p>
        `;
        text = `Cześć ${reg.first_name}, rezerwacja przyjęta. Kod: ${payment_ref}. Masz 3 dni robocze na opłatę.`;
      } else {
        subject = `Aktualizacja zgłoszenia — ${payment_ref}`;
        html = `<p>Cześć ${reg.first_name},</p><p>Zarejestrowaliśmy akcję: <strong>${action}</strong> dla kodu ${payment_ref}.</p>`;
        text = `Akcja ${action} dla ${payment_ref}`;
      }

      // wyślij mail (Resend)
      await sendResendEmail({
        to: reg.email,
        subject,
        html,
        text,
      });

      return json(res, 200, { ok: true });
    }

    // GET /api/payment-document?payment_ref=XXXX
    if (req.method === "GET" && sub === "payment-document") {
      const payment_ref = url.searchParams.get("payment_ref");
      if (!payment_ref) return json(res, 400, { error: "Brak payment_ref." });

      const r = await dbQuery(`SELECT * FROM registrations WHERE payment_ref=$1 LIMIT 1`, [payment_ref]);
      const reg = r.rows[0];
      if (!reg) return json(res, 404, { error: "Nie znaleziono zapisu." });

      // wygeneruj dokument (na start HTML jako download)
      const html = buildPaymentDocHTML({
        ...reg,
        transfer_title: reg.transfer_title || `Krav Maga ${reg.first_name} ${reg.last_name} ${reg.payment_ref}`,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="dokument-platniczy-${payment_ref}.html"`);
      res.end(html);
      return;
    }

    return notFound(res);
  } catch (e) {
    return json(res, 500, { error: e.message || "Server error" });
  }
}
