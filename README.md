# GIB Partnership Service

Backend service and admin UI for the Grove Intelligence Bureau (GIB) Partner Program.

This app handles:

- Public partner landing page (`/partners`)
- Partner application form (`/partners/apply`)
- Admin dashboard for reviewing applications and logs (`/partners/admin`)
- Integration with MailerLite (via the main `groveintel.com` landing waitlist endpoint)
- Integration with Tapfiliate for creating/attaching affiliates on approval
- Postgres persistence for applications and admin logs

## 1. Tech Stack

- Node.js + Express
- PostgreSQL
- Vanilla HTML/CSS/JS (served from `public/`)
- Tapfiliate REST API
- MailerLite (indirectly via `LANDING_WAITLIST_URL`)

## 2. Important Files & Folders

- `server.js` – Express app, API routes, Tapfiliate sync logic.
- `public/partners.html` – Public partner landing page.
- `public/partners-apply.html` – Partner application form.
- `public/partners-admin.html` – Admin dashboard.
- `public/css/partners.css` – Shared styling for all three pages.
- `public/js/partner-apply.js` – Client-side form handling for `/partners/apply`.
- `.env` – Local environment variables (ignored by Git).

## 3. Environment Variables

Create a `.env` file (for local dev) with:

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

On Render or other hosting, configure these in the service **Environment** settings instead of committing `.env`.

## 4. Database Schema (high level)

Two core tables:

- `partner_applications`
  - Stores each partner application and its status (`pending`, `approved`, `rejected`).
  - Includes contact info, context fields, and `tapfiliate_affiliate_id` (set after approval/sync).

- `admin_logs`
  - Audit log for admin actions (approve/reject/clear/sync).
  - Stores `admin_identifier`, `action`, `application_id`, `details`, `created_at`.

Migrations/DDL are not included here; create tables to match the usage in `server.js`.

## 5. Running Locally

```bash
npm install
npm start
# server runs on http://localhost:3000
```

Then visit:

- `http://localhost:3000/partners` – Partner landing
- `http://localhost:3000/partners/apply` – Application form
- `http://localhost:3000/partners/admin` – Admin (requires `ADMIN_API_TOKEN`)

## 6. Admin Flow

1. Go to `/partners/admin`.
2. Enter the `ADMIN_API_TOKEN` and click **Sign in**.
3. Use tabs to view **Pending**, **Approved**, **Rejected**, **Logs**.
4. On **Pending**:
   - **Approve** – updates DB, logs the action, and triggers Tapfiliate sync (create affiliate + add to program).
   - **Reject** – opens a modal to optionally record a rejection reason; logs the action.
5. **Clear All** (on any tab) – opens a modal that:
   - Exports all applications to a downloaded JSON backup.
   - Calls `DELETE /api/partner-applications` to clear the table.

## 7. Tapfiliate Integration (summary)

On approval of an application:

1. The app ensures `tapfiliate_affiliate_id` column exists.
2. It loads the application (name + email).
3. It creates or reuses an affiliate via `POST /1.6/affiliates/`.
4. It stores the Tapfiliate affiliate ID on the application.
5. It adds the affiliate to the configured program via `POST /1.6/programs/{program_id}/affiliates/`.
6. It logs a `tapfiliate_sync` entry in `admin_logs`.

Tapfiliate keys and program ID are controlled via env vars.

## 8. Deployment (Render + GoDaddy)

Typical production setup:

1. Push this project to GitHub.
2. Create a **Web Service** on Render:
   - Build command: `npm install`
   - Start command: `node server.js` or `npm start`
   - Set all env vars in Render.
3. Test via the Render URL (e.g. `https://gib-partners.onrender.com/partners`).
4. In GoDaddy DNS for `groveintel.com`, add a CNAME:
   - Name: `partners`
   - Value: your Render hostname (e.g. `gib-partners.onrender.com`).
5. Once DNS propagates, use:
   - `https://partners.groveintel.com/partners`
   - `https://partners.groveintel.com/partners/apply`
   - `https://partners.groveintel.com/partners/admin`

## 9. Resetting Data Before Go-Live

To clear test data from production Postgres before launch:

```sql
TRUNCATE TABLE admin_logs, partner_applications RESTART IDENTITY;
```

This wipes all applications and logs and resets IDs, so the live system starts clean.
