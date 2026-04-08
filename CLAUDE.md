# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Saggita Krav Maga — system zapisów i panel zarządzania dla szkoły krav maga. Stack: plain Node.js (CommonJS, no transpilation), Vercel serverless functions, PostgreSQL (via `pg`).

## Development

No build step. Deploy via Vercel (`vercel deploy`). No test suite.

Local development: `vercel dev` (requires Vercel CLI and `.env.local` with env vars).

## Environment Variables

Required in production and `.env.local` for local dev:
- `DATABASE_URL` / `POSTGRES_URL` / `NEON_DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — shared secret for all JWTs (admin + instructor)
- `PAYNOW_API_KEY`, `PAYNOW_SIGNATURE_KEY` — PayNow (mBank) payment API
- `PAYNOW_SANDBOX=true` for sandbox mode
- `SITE_URL`, `API_URL`, `BANK_ACCOUNT`, `BANK_NAME` — branding/config

## Architecture

### Vercel Function Limit (Hobby: 12 functions)

The project works within Vercel Hobby's 12-function limit. All new API logic must be added to existing files, not new ones. Current function files:
1. `api/catalog.js`
2. `api/ping.js`
3. `api/register.js`
4. `api/saggita.js` ← central router for all instructor + student endpoints
5. `api/registration/action.js` ← registration form + PayNow webhook
6. `api/admin-api/login.js`
7. `api/admin-api/stats.js`
8. `api/admin-api/plans.js`
9. `api/admin-api/resource.js` ← CRUD for groups, schedules, locations, instructors
10. `api/admin-api/groups.js`
11. `api/admin-api/locations.js`
12. `api/admin-api/schedules.js`

### URL Routing

`vercel.json` rewrites map clean URLs to function files with query params. Key patterns:
- `/api/instructor/*` → `api/saggita.js?_module=instructor-*`
- `/api/admin-api/students/*` → `api/saggita.js?_module=students`
- `/api/admin-api/sessions` → `api/admin-api/resource.js?type=sessions`
- Most admin CRUD → `api/admin-api/resource.js?type={resource}&id={id}`

Never add a new URL path without a corresponding rewrite in `vercel.json`.

### Central Router Pattern (`api/saggita.js`)

All instructor panel endpoints go through `api/saggita.js`, which dispatches on `?_module=`:
- `instructor-auth`, `instructor-panel`, `instructor-attendance`, `instructor-students`, `instructor-calendar`, `instructor-session-mgmt`, `instructor-events` → all handled by `api/_saggita/panel.js`
- `registrations`, `students` → `api/_saggita/registrations.js`, `api/_saggita/students.js`

Within handlers, sub-routing uses `req.query._route` and `req.query.id`.

### Shared Libraries (`api/_lib/`)

- `db.js` — singleton `pg.Pool`, reads connection from env vars
- `auth.js` — `requireAuth(req)` for admin JWT verification (Bearer token, HS256)
- `mail.js` — nodemailer helpers
- `paynow.js` — PayNow (mBank) payment creation and webhook signature verification

`panel.js` duplicates JWT logic internally (does not use `_lib/auth.js`) and additionally checks `role === 'instructor'` in the token payload.

### Authentication

- **Admin**: `admin_users` table, bcrypt password, JWT issued by `api/admin-api/login.js`, verified by `api/_lib/auth.js`
- **Instructor**: `instructors` table, bcrypt password, JWT issued and verified within `api/_saggita/panel.js`; token payload includes `role: 'instructor'` and permissions object

### Database

PostgreSQL, constant `SEASON = '2025-09-01'` used for filtering current-season data (defined in `api/_saggita/panel.js`).

Key tables: `instructors`, `instructor_permissions`, `instructor_groups`, `groups`, `training_sessions`, `student_groups`, `registrations`, `price_plans`, `schedules`, `locations`, `admin_users`.

Migrations are run via `POST /api/admin-api/resource?type=run-migrations` (endpoint in `resource.js`), not via CLI tools.

### Frontend

Single-page vanilla JS apps in `public/`:
- `admin.html` — admin panel (requires JWT in localStorage)
- `instruktor.html` / `instructor.html` — instructor panel (requires JWT in localStorage)

Both apps make fetch calls directly to `/api/*` endpoints. No bundler, no framework.

### PayNow Integration

`api/_lib/paynow.js` creates payments and verifies webhooks. The webhook route `/api/webhooks/paynow` is rewritten to `api/registration/action.js?_webhook=paynow`. PayNow sends `Signature` header (Base64 HMAC-SHA256 of raw body with `PAYNOW_SIGNATURE_KEY`).

Because iframes block top-level navigation, payment redirects use `window.top.location` (see `action.js`).
