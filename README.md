# GIB Partnership Service

This repo contains the backend service and internal admin UI I use to run the Grove Intelligence Bureau (GIB) Partner Program.

With this app I can:

- Expose a public partner landing page (`/partners`).
- Collect partner applications (`/partners/apply`).
- Review and manage applications in a secure admin dashboard (`/partners/admin`).
- Sync approved partners into Tapfiliate as affiliates.
- Keep an audit log of what happened (and who did what) in Postgres.

## 1. Tech stack

I kept the stack intentionally simple and lightweight:

- Node.js + Express for the API and server-side logic.
- PostgreSQL for durable storage.
- Vanilla HTML/CSS/JS in `public/` for the three front-end pages.
- Tapfiliate REST API for affiliate management.
- MailerLite (indirectly via `LANDING_WAITLIST_URL`) for mailing list onboarding.

## 2. Important files & folders

Here are the key pieces I actually care about when I come back to this project:

- `server.js` – Express app, API routes, Tapfiliate sync logic, admin auth.
- `public/partners.html` – Public partner landing page.
- `public/partners-apply.html` – Partner application form.
- `public/partners-admin.html` – Admin dashboard.
- `public/css/partners.css` – Shared styling for all three pages.
- `public/js/partner-apply.js` – Client-side form handling for `/partners/apply`.
- `.env` – Local environment variables (ignored by Git).

## 3. Environment variables

Locally, I use a `.env` file. In production (Render), I set these via the dashboard.

For local dev, create `.env` with:

```env
DATABASE_URL=postgresql://<user>:<pass>@<host>:<port>/<db>
NODE_ENV=development
ADMIN_API_TOKEN=<admin-token>

MAILERLITE_API_KEY=<optional-if-used-directly>
MAILERLITE_GROUP_ID=<optional-if-used-directly>
LANDING_WAITLIST_URL=https://api.groveintel.com/api/join-waitlist

TAPFILIATE_API_KEY=<tapfiliate-api-key>
TAPFILIATE_PROGRAM_ID=grove-intelligence-bureau-partners-program
```

On Render or other hosting, I configure these in the service **Environment** settings instead of committing `.env`.

## 4. Database schema (high level)

I currently rely on two core tables:

- `partner_applications`
  - Each row is a partner application and its status (`pending`, `approved`, `rejected`).
  - Includes contact info, context fields, and `tapfiliate_affiliate_id` (set after approval/sync).

- `admin_logs`
  - Audit log for admin actions (approve/reject/clear/sync).
  - Stores `admin_identifier`, `action`, `application_id`, `details`, `created_at`.

Migrations/DDL aren’t in this repo yet; I create/update tables to match what `server.js` expects.

## 5. Running locally

```bash
npm install
npm start
# server runs on http://localhost:3000
```

Then I use:

- `http://localhost:3000/partners` – Partner landing.
- `http://localhost:3000/partners/apply` – Application form.
- `http://localhost:3000/partners/admin` – Admin (requires `ADMIN_API_TOKEN`).

## 6. Admin flow

How I use the admin dashboard day to day:

1. Go to `/partners/admin`.
2. Enter `ADMIN_API_TOKEN` and click **Sign in**.
3. Use the tabs to switch between **Pending**, **Approved**, **Rejected**, and **Logs**.
4. On **Pending**:
   - **Approve** – updates the DB, logs the action, and triggers Tapfiliate sync (create affiliate + add to program).
   - **Reject** – opens a modal where I can optionally add a rejection reason; that goes into the admin log.
5. **Clear All** – opens a modal that:
   - Exports all applications to a downloaded JSON backup.
   - Calls `DELETE /api/partner-applications` to clear the table.

## 7. Tapfiliate integration

When I approve an application, the backend walks through this flow:

1. Make sure the `tapfiliate_affiliate_id` column exists on `partner_applications`.
2. Load the application (name, email, etc.).
3. Create or reuse an affiliate via `POST /1.6/affiliates/`.
4. Store the Tapfiliate affiliate ID on the application row.
5. Add the affiliate to the configured program via `POST /1.6/programs/{program_id}/affiliates/`.
6. Write a `tapfiliate_sync` entry into `admin_logs` so I can audit what happened later.

Tapfiliate keys and program ID are all controlled by env vars so I can switch environments without code changes.

## 8. Deployment (Render + GoDaddy)

The production setup I use today looks like this:

1. Push this project to GitHub.
2. Create a **Web Service** on Render, pointed at this repo:
   - Build command: `npm install`
   - Start command: `node server.js` or `npm start`
   - Set all env vars in Render.
3. Smoke-test via the Render URL (e.g. `https://gib-partners.onrender.com/partners`).
4. In GoDaddy DNS for `groveintel.com`, add a CNAME:
   - Name: `partners`
   - Value: the Render hostname (e.g. `gib-partners.onrender.com`).
5. Once DNS propagates, I use:
   - `https://partners.groveintel.com/partners`
   - `https://partners.groveintel.com/partners/apply`
   - `https://partners.groveintel.com/partners/admin`

## 9. Resetting data before go‑live

Right before launch (or whenever I want a clean slate in production), I clear out test data from Postgres:

```sql
TRUNCATE TABLE admin_logs, partner_applications RESTART IDENTITY;
```

That wipes all applications and logs and resets the IDs, so real partner data starts from a fresh state.
