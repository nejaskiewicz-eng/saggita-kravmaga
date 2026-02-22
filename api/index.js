import { Pool } from 'pg'
import jwt from 'jsonwebtoken'

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
    // STARE ŚCIEŻKI ADMIN-API (żeby nie ruszać frontu)
    // =========================

    if (url.startsWith('/api/admin-api/login') && method === 'POST') {
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

    const authHeader = req.headers.authorization
    let decoded = null

    if (authHeader) {
      const token = authHeader.split(' ')[1]
      decoded = jwt.verify(token, process.env.JWT_SECRET)
    }

    if (url.startsWith('/api/admin-api/registrations') && method === 'GET') {
      if (!decoded) return json(res, 401, { error: 'Brak autoryzacji' })

      const result = await pool.query(
        `SELECT * FROM registrations ORDER BY id DESC`
      )

      return json(res, 200, result.rows)
    }

    // =========================
    // PUBLIC
    // =========================

    if (url.startsWith('/api/register') && method === 'POST') {
      const data = req.body

      const result = await pool.query(
        `INSERT INTO registrations(name,email,phone,plan_id)
         VALUES($1,$2,$3,$4) RETURNING *`,
        [data.name, data.email, data.phone, data.plan_id]
      )

      return json(res, 200, result.rows[0])
    }

    return json(res, 404, { error: 'Nie znaleziono endpointu' })

  } catch (err) {
    console.error(err)
    return json(res, 500, { error: 'Błąd serwera' })
  }
}