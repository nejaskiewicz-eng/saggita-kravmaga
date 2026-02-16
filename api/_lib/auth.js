// api/_lib/auth.js — weryfikacja JWT (NIE jest funkcją Vercel)
const crypto = require('crypto');

function base64urlDecode(str) {
  // Dopełnij padding
  const pad = str.length % 4;
  const padded = pad ? str + '='.repeat(4 - pad) : str;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifyJWT(token, secret) {
  if (!token) throw new Error('Brak tokenu');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Nieprawidłowy format tokenu');

  const [header, payload, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  if (sig !== expected) throw new Error('Nieważny token');

  const data = JSON.parse(base64urlDecode(payload).toString());
  return data;
}

// Middleware: wywołaj przed logiką chronionego endpointu
// Zwraca payload lub rzuca błąd
function requireAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Brak JWT_SECRET');
  return verifyJWT(token, secret);
}

module.exports = { requireAuth };
