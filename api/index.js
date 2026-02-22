import { Pool } from 'pg'
import jwt from 'jsonwebtoken'
import nodemailer from 'nodemailer'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

function json(res, status, data) {
  res.status(status).json(data)
}

export default async function handler(req, res) {
  const { method, url } = req

  try {

    // =========================
    // PUBLIC ROUTES
    // =========================

    if (url.startsWith('/api/schedule') && method === 'GET') {
      const result = await pool.query(`SELECT * FROM schedules`)
      return json(res, 200, result.rows)
    }

    if (url.startsWith('/api/prices') && method === 'GET') {
      const result = await pool.query(`SELECT * FROM plans WHERE active = true`)
      return json(res, 200, result.rows)
    }

    if (url.startsWith('/api/register') && method === 'POST') {
      const data = req.body

      const result = await pool.query(
        `INSERT INTO registrations(name,email,phone,plan_id)
         VALUES($1,$2,$3,$4) RETURNING *`,
        [data.name, data.email, data.phone, data.plan_id]
      )

      return json(res, 200, result.rows[0])
    }

    // =========================
    // ADMIN LOGIN
    // =========================

    if (url.startsWith('/api/login') && method === 'POST') {
      const { email, password } = req.body

      const result = await pool.query(
        `SELECT * FROM users WHERE email = $1`,
        [email]
      )

      if (!result.rows.length) {
        return json(res, 401, { error: 'Nie znaleziono użytkownika' })
      }

      const user = result.rows[0]

      if (password !== user.password) {
        return json(res, 401, { error: 'Błędne hasło' })
      }

      const token = jwt.sign(
        { id: user.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
      )

      return json(res, 200, { token })
    }

    // =========================
    // AUTH CHECK
    // =========================

    const authHeader = req.headers.authorization
    if (!authHeader) {
      return json(res, 401, { error: 'Brak tokenu' })
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    // =========================
    // ADMIN - LISTA ZAPISÓW
    // =========================

    if (url.startsWith('/api/admin/registrations') && method === 'GET') {
      const result = await pool.query(`SELECT * FROM registrations ORDER BY id DESC`)
      return json(res, 200, result.rows)
    }

    // =========================
    // INSTRUKTOR - GRUPY
    // =========================

    if (url.startsWith('/api/instructor/groups') && method === 'GET') {
      const result = await pool.query(
        `SELECT * FROM groups WHERE instructor_id = $1`,
        [decoded.id]
      )
      return json(res, 200, result.rows)
    }

    return json(res, 404, { error: 'Nie znaleziono endpointu' })

  } catch (err) {
    console.error(err)
    return json(res, 500, { error: 'Błąd serwera' })
  }
}