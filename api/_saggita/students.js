// api/admin-api/students.js  — FUNKCJA #9
// Ujednolicona baza kursantów: legacy (students) + nowe zapisy (registrations)
const { getPool } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try { requireAuth(req); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized: ' + e.message }); }

  const pool = getPool();
  const { id, pid, aid, _route, search, source, group_id, city,
          payment_status, is_active, page = 1, limit = 60, sort = 'recent' } = req.query;

  // ── SUB-ROUTE: płatności ──────────────────────────────────────
  if (id && _route === 'payments') {
    if (req.method === 'GET') {
      const { rows: legacy } = await pool.query(
        `SELECT id,'legacy' AS type,amount,paid_at AS date,note FROM legacy_payments WHERE student_id=$1 ORDER BY paid_at DESC NULLS LAST`, [id]
      ).catch(e => ({ rows: [] }));
      const { rows: regs } = await pool.query(
        `SELECT r.id,'registration' AS type,r.total_amount AS amount,r.created_at AS date,r.admin_notes AS note,r.payment_ref,r.payment_status AS status,pp.name AS plan_name FROM students s JOIN registrations r ON r.id=s.registration_id LEFT JOIN price_plans pp ON pp.id=r.price_plan_id WHERE s.id=$1 AND s.registration_id IS NOT NULL`, [id]
      ).catch(e => ({ rows: [] }));
      return res.status(200).json({ legacy, registrations: regs });
    }
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.amount) return res.status(400).json({ error: 'Kwota jest wymagana.' });
      try {
        const { rows: [p] } = await pool.query(
          `INSERT INTO legacy_payments (student_id,amount,paid_at,note) VALUES ($1,$2,$3,$4) RETURNING *`,
          [id, parseFloat(b.amount), b.date || new Date().toISOString().slice(0,10), b.note||null]
        );
        return res.status(201).json(p);
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
    if (req.method === 'PATCH' && pid) {
      const b = req.body || {};
      const set=[],vals=[];let pi=1;
      for(const k of ['amount','paid_at','note']) if(k in b){set.push(`${k}=$${pi++}`);vals.push(b[k]);}
      if(!set.length) return res.status(400).json({error:'Brak pól.'});
      vals.push(pid,id);
      try { await pool.query(`UPDATE legacy_payments SET ${set.join(',')} WHERE id=$${pi} AND student_id=$${pi+1}`,vals); return res.status(200).json({success:true}); }
      catch(e) { return res.status(500).json({error:e.message}); }
    }
    if (req.method === 'DELETE' && pid) {
      try { await pool.query(`DELETE FROM legacy_payments WHERE id=$1 AND student_id=$2`,[pid,id]); return res.status(200).json({success:true}); }
      catch(e) { return res.status(500).json({error:e.message}); }
    }
    return res.status(405).json({error:'Method not allowed'});
  }

  // ── SUB-ROUTE: obecności ──────────────────────────────────────
  if (id && _route === 'attendance') {
    if (req.method === 'GET') {
      try {
        const { rows } = await pool.query(
          `SELECT a.id,a.present,a.diff_group,ts.session_date,ts.id AS session_id,g.name AS group_name FROM attendances a JOIN training_sessions ts ON ts.id=a.session_id LEFT JOIN groups g ON g.id=ts.group_id WHERE a.student_id=$1 ORDER BY ts.session_date DESC LIMIT 200`,
          [id]
        );
        return res.status(200).json({ rows });
      } catch(e) { return res.status(500).json({error:e.message}); }
    }
    if (req.method === 'PATCH' && aid) {
      const { present } = req.body||{};
      try { await pool.query(`UPDATE attendances SET present=$1 WHERE id=$2`,[!!present,aid]); return res.status(200).json({success:true}); }
      catch(e) { return res.status(500).json({error:e.message}); }
    }
  }

  // ── SUB-ROUTE: status płatności rejestracji ───────────────────
  if (id && _route === 'reg-payment') {
    if (req.method === 'PATCH') {
      const { registration_id, payment_status: ps } = req.body||{};
      if (!registration_id || !ps) return res.status(400).json({error:'Brak danych.'});
      try {
        await pool.query(`UPDATE registrations SET payment_status=$1,updated_at=NOW() WHERE id=$2`,[ps,registration_id]);
        return res.status(200).json({success:true});
      } catch(e) { return res.status(500).json({error:e.message}); }
    }
  }

  // ── GET szczegóły kursanta ────────────────────────────────────
  if (req.method === 'GET' && id) {
    try {
      const { rows:[student] } = await pool.query(`
        SELECT s.*,
          COALESCE(json_agg(DISTINCT jsonb_build_object('id',g.id,'name',g.name,'active',sg.active)) FILTER (WHERE g.id IS NOT NULL),'[]') AS groups,
          COUNT(DISTINCT a.id) FILTER (WHERE a.present=true)::int AS total_present,
          COUNT(DISTINCT a.id)::int AS total_sessions,
          ROUND(COUNT(DISTINCT a.id) FILTER (WHERE a.present=true)::numeric/NULLIF(COUNT(DISTINCT a.id),0)*100,0)::int AS attendance_pct,
          COALESCE(SUM(DISTINCT lp.amount),0)::numeric AS total_legacy_paid,
          MAX(ts.session_date) AS last_training
        FROM students s
        LEFT JOIN student_groups sg ON sg.student_id=s.id
        LEFT JOIN groups g ON g.id=sg.group_id
        LEFT JOIN attendances a ON a.student_id=s.id
        LEFT JOIN training_sessions ts ON ts.id=a.session_id
        LEFT JOIN legacy_payments lp ON lp.student_id=s.id
        WHERE s.id=$1 GROUP BY s.id
      `,[id]);
      if(!student) return res.status(404).json({error:'Nie znaleziono.'});
      let registration=null;
      if(student.registration_id){
        const {rows:[r]}=await pool.query(`SELECT r.*,g.name AS group_name,l.city,pp.name AS plan_name FROM registrations r LEFT JOIN groups g ON g.id=r.group_id LEFT JOIN locations l ON l.id=r.location_id LEFT JOIN price_plans pp ON pp.id=r.price_plan_id WHERE r.id=$1`,[student.registration_id]);
        registration=r;
      }
      return res.status(200).json({...student,registration});
    } catch(e) { console.error('[students GET id]',e); return res.status(500).json({error:e.message}); }
  }

  // ── GET lista (ujednolicona, z filtrami) ──────────────────────
  if (req.method === 'GET') {
    try {
      const { overdue } = req.query;
      const conds=[],vals=[];let pi=1;
      if(search){conds.push(`(s.first_name ILIKE $${pi} OR s.last_name ILIKE $${pi} OR s.email ILIKE $${pi} OR s.phone ILIKE $${pi})`);vals.push(`%${search}%`);pi++;}
      if(source&&source!=='all'){conds.push(`s.source=$${pi++}`);vals.push(source);}
      if(is_active!==undefined&&is_active!==''){conds.push(`s.is_active=$${pi++}`);vals.push(is_active==='true');}
      if(group_id){conds.push(`EXISTS(SELECT 1 FROM student_groups sg2 WHERE sg2.student_id=s.id AND sg2.group_id=$${pi++})`);vals.push(parseInt(group_id));}
      if(city){conds.push(`EXISTS(SELECT 1 FROM student_groups sg3 JOIN groups g3 ON g3.id=sg3.group_id JOIN locations l3 ON l3.id=g3.location_id WHERE sg3.student_id=s.id AND l3.city ILIKE $${pi++})`);vals.push(`%${city}%`);}
      if(payment_status&&payment_status!=='all'){conds.push(`EXISTS(SELECT 1 FROM registrations r2 WHERE r2.id=s.registration_id AND r2.payment_status=$${pi++})`);vals.push(payment_status);}
      // Filtr zaległości: aktywni, byli na treningu w ostatnich 60 dniach, ostatnia wpłata >35 dni lub brak
      if(overdue==='true'){
        conds.push(`s.is_active=true`);
        conds.push(`EXISTS(SELECT 1 FROM attendances a2 JOIN training_sessions ts2 ON ts2.id=a2.session_id WHERE a2.student_id=s.id AND a2.present=true AND ts2.session_date >= CURRENT_DATE - INTERVAL '60 days')`);
        conds.push(`(
          (s.registration_id IS NULL AND (SELECT MAX(lp2.paid_at) FROM legacy_payments lp2 WHERE lp2.student_id=s.id) < CURRENT_DATE - INTERVAL '35 days')
          OR (s.registration_id IS NULL AND NOT EXISTS(SELECT 1 FROM legacy_payments lp3 WHERE lp3.student_id=s.id))
          OR (s.registration_id IS NOT NULL AND EXISTS(SELECT 1 FROM registrations r3 WHERE r3.id=s.registration_id AND r3.payment_status NOT IN ('paid')))
        )`);
      }
      const where=conds.length?'WHERE '+conds.join(' AND '):'';
      const offset=(parseInt(page)-1)*parseInt(limit);
      const {rows:[{total}]}=await pool.query(`SELECT COUNT(*)::int AS total FROM students s ${where}`,vals);
      const {rows}=await pool.query(`
        SELECT s.id,s.legacy_id,s.first_name,s.last_name,s.email,s.phone,s.birth_year,s.is_active,s.source,s.created_at,s.registration_id,
          COALESCE(json_agg(DISTINCT jsonb_build_object('id',g.id,'name',g.name)) FILTER (WHERE g.id IS NOT NULL),'[]') AS groups,
          COUNT(DISTINCT a.id) FILTER (WHERE a.present=true)::int AS total_present,
          COUNT(DISTINCT a.id) FILTER (WHERE a.present=true AND ts.session_date >= CURRENT_DATE - INTERVAL '60 days')::int AS present_60d,
          MAX(ts.session_date) AS last_training,
          COALESCE(SUM(DISTINCT lp.amount),0)::numeric AS legacy_paid,
          MAX(lp.paid_at) AS last_payment_date,
          CASE WHEN MAX(lp.paid_at) IS NOT NULL THEN (CURRENT_DATE - MAX(lp.paid_at)::date)::int ELSE NULL END AS days_since_payment,
          r.payment_status,r.total_amount,pp.name AS plan_name,l.city
        FROM students s
        LEFT JOIN student_groups sg ON sg.student_id=s.id AND sg.active=true
        LEFT JOIN groups g ON g.id=sg.group_id
        LEFT JOIN locations l ON l.id=g.location_id
        LEFT JOIN attendances a ON a.student_id=s.id
        LEFT JOIN training_sessions ts ON ts.id=a.session_id
        LEFT JOIN legacy_payments lp ON lp.student_id=s.id
        LEFT JOIN registrations r ON r.id=s.registration_id
        LEFT JOIN price_plans pp ON pp.id=r.price_plan_id
        ${where}
        GROUP BY s.id,r.payment_status,r.total_amount,pp.name,l.city
        ORDER BY ${sort === 'alpha' ? 's.last_name, s.first_name' : sort === 'payment' ? 'MAX(lp.paid_at) DESC NULLS LAST, s.last_name, s.first_name' : 'MAX(ts.session_date) DESC NULLS LAST, MAX(lp.paid_at) DESC NULLS LAST, s.last_name, s.first_name'}
        LIMIT $${pi} OFFSET $${pi+1}
      `,[...vals,parseInt(limit),offset]);
      return res.status(200).json({rows,total,page:parseInt(page),limit:parseInt(limit)});
    } catch(e) { console.error('[students GET list]',e); return res.status(500).json({error:e.message}); }
  }

  // ── POST nowy kursant ─────────────────────────────────────────
  if (req.method === 'POST') {
    const b=req.body||{};
    if(!b.first_name||!b.last_name) return res.status(400).json({error:'Imię i nazwisko są wymagane.'});
    try {
      const {rows:[s]}=await pool.query(
        `INSERT INTO students (first_name,last_name,email,phone,birth_year,is_active,source) VALUES ($1,$2,$3,$4,$5,$6,'manual') RETURNING *`,
        [b.first_name.trim(),b.last_name.trim(),b.email||null,b.phone||null,b.birth_year||null,b.is_active!==false]
      );
      if(b.group_id) await pool.query(`INSERT INTO student_groups (student_id,group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[s.id,b.group_id]);
      return res.status(201).json(s);
    } catch(e) { return res.status(500).json({error:e.message}); }
  }

  // ── PATCH edytuj kursanta ─────────────────────────────────────
  if (req.method === 'PATCH' && id) {
    const b=req.body||{};
    const set=[],vals=[];let pi=1;
    for(const k of ['first_name','last_name','email','phone','birth_year','is_active']) if(k in b){set.push(`${k}=$${pi++}`);vals.push(b[k]);}
    if(!set.length) return res.status(400).json({error:'Brak pól.'});
    vals.push(id);
    try { await pool.query(`UPDATE students SET ${set.join(',')} WHERE id=$${pi}`,vals); return res.status(200).json({success:true}); }
    catch(e) { return res.status(500).json({error:e.message}); }
  }

  // ── DELETE usuń / dezaktywuj ──────────────────────────────────
  if (req.method === 'DELETE' && id) {
    try {
      const {rows:[{att,pay}]}=await pool.query(`SELECT (SELECT COUNT(*) FROM attendances WHERE student_id=$1)::int AS att,(SELECT COUNT(*) FROM legacy_payments WHERE student_id=$1)::int AS pay`,[id]);
      if(att>0||pay>0){
        await pool.query(`UPDATE students SET is_active=false WHERE id=$1`,[id]);
        return res.status(200).json({success:true,soft:true,message:'Dezaktywowano (kursant ma historię)'});
      }
      await pool.query(`DELETE FROM student_groups WHERE student_id=$1`,[id]);
      await pool.query(`DELETE FROM students WHERE id=$1`,[id]);
      return res.status(200).json({success:true,soft:false});
    } catch(e) { return res.status(500).json({error:e.message}); }
  }

  return res.status(405).json({error:'Method not allowed'});
};
