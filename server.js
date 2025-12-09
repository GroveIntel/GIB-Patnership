require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');

// Lazy node-fetch import so we can use fetch reliably in Node
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT;

// Optional: forward new partner emails to existing landing waitlist endpoint
const LANDING_WAITLIST_URL = process.env.LANDING_WAITLIST_URL;

// Tapfiliate configuration
const TAPFILIATE_API_KEY = process.env.TAPFILIATE_API_KEY;
const TAPFILIATE_PROGRAM_ID = process.env.TAPFILIATE_PROGRAM_ID;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.get('/api/admin-logs/export', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_identifier VARCHAR(255),
        action VARCHAR(50),
        application_id INT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    const result = await pool.query(
      'SELECT * FROM admin_logs ORDER BY created_at DESC'
    );

    return res.status(200).json({ success: true, logs: result.rows });
  } catch (err) {
    console.error('Error exporting admin logs:', err);
    return res.status(500).json({ success: false, message: 'Error exporting logs.' });
  }
});

app.delete('/api/admin-logs', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_identifier VARCHAR(255),
        action VARCHAR(50),
        application_id INT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await pool.query('DELETE FROM admin_logs');

    // Optionally record that logs were cleared (will only appear in future logs)
    await pool.query(
      `INSERT INTO admin_logs (admin_identifier, action, application_id, details)
       VALUES ($1, $2, $3, $4)`,
      ['admin', 'clear_logs', null, 'Admin logs cleared via admin UI']
    );

    return res.status(200).json({ success: true, message: 'All admin logs have been deleted.' });
  } catch (err) {
    console.error('Error clearing admin logs:', err);
    return res.status(500).json({ success: false, message: 'Error clearing logs.' });
  }
});

// Admin utility endpoints
app.get('/api/partner-applications/export', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM partner_applications ORDER BY created_at DESC');
    return res.status(200).json({ success: true, applications: result.rows });
  } catch (err) {
    console.error('Error exporting partner applications:', err);
    return res.status(500).json({ success: false, message: 'Error exporting applications.' });
  }
});

app.delete('/api/partner-applications', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM partner_applications');

    await pool.query(
      `CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_identifier VARCHAR(255),
        action VARCHAR(50),
        application_id INT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await pool.query(
      `INSERT INTO admin_logs (admin_identifier, action, application_id, details)
       VALUES ($1, $2, $3, $4)`,
      ['admin', 'clear_all', null, 'All partner applications cleared via admin UI']
    );

    return res.status(200).json({ success: true, message: 'All partner applications have been deleted.' });
  } catch (err) {
    console.error('Error clearing partner applications:', err);
    return res.status(500).json({ success: false, message: 'Error clearing applications.' });
  }
});

const adminAttempts = {};

async function forwardEmailToLanding(email) {
  try {
    if (!email) return;

    if (!LANDING_WAITLIST_URL) {
      console.warn('LANDING_WAITLIST_URL is not configured. Skipping waitlist forwarding.');
      return;
    }

    const response = await fetch(LANDING_WAITLIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('Landing waitlist endpoint responded with non-OK status:', response.status, text);
    }
  } catch (err) {
    console.error('Error forwarding email to landing waitlist endpoint:', err);
  }
}

async function syncTapfiliateAffiliate(applicationId) {
  try {
    if (!TAPFILIATE_API_KEY || !TAPFILIATE_PROGRAM_ID) {
      console.warn('Tapfiliate not fully configured (missing API key or program id). Skipping Tapfiliate sync.');
      return;
    }

    // Ensure the column for storing Tapfiliate affiliate id exists
    await pool.query(
      `ALTER TABLE partner_applications
         ADD COLUMN IF NOT EXISTS tapfiliate_affiliate_id VARCHAR(255)`
    );

    // Load the application so we have name + email and current tapfiliate_affiliate_id
    const result = await pool.query(
      `SELECT id, name, email, tapfiliate_affiliate_id
       FROM partner_applications
       WHERE id = $1`,
      [applicationId]
    );

    if (result.rows.length === 0) {
      console.warn('Tapfiliate sync: application not found for id', applicationId);
      return;
    }

    const appRow = result.rows[0];
    const { email, name } = appRow;

    if (!email) {
      console.warn('Tapfiliate sync: application has no email, skipping. id=', applicationId);
      return;
    }

    let affiliateId = appRow.tapfiliate_affiliate_id;

    // Step 1: create affiliate if we don't have one yet
    if (!affiliateId) {
      const [firstname, ...rest] = (name || '').trim().split(' ');
      const lastname = rest.join(' ');

      const createPayload = {
        email,
        firstname: firstname || undefined,
        lastname: lastname || undefined
      };

      const createRes = await fetch('https://api.tapfiliate.com/1.6/affiliates/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': TAPFILIATE_API_KEY
        },
        body: JSON.stringify(createPayload)
      });

      if (!createRes.ok) {
        const text = await createRes.text().catch(() => '');
        console.error('Tapfiliate create affiliate failed:', createRes.status, text);
        return;
      }

      const created = await createRes.json().catch(() => null);
      if (!created || !created.id) {
        console.error('Tapfiliate create affiliate: missing id in response');
        return;
      }

      affiliateId = created.id;

      await pool.query(
        `UPDATE partner_applications
         SET tapfiliate_affiliate_id = $1
         WHERE id = $2`,
        [affiliateId, applicationId]
      );
    }

    // Step 2: add affiliate to program and approve
    const progUrl = `https://api.tapfiliate.com/1.6/programs/${encodeURIComponent(TAPFILIATE_PROGRAM_ID)}/affiliates/`;

    const progRes = await fetch(progUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': TAPFILIATE_API_KEY
      },
      body: JSON.stringify({ affiliate: { id: affiliateId }, approved: true })
    });

    if (!progRes.ok) {
      const text = await progRes.text().catch(() => '');
      console.error('Tapfiliate add affiliate to program failed:', progRes.status, text);
      return;
    }

    // Log success in admin_logs for audit trail
    await pool.query(
      `CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_identifier VARCHAR(255),
        action VARCHAR(50),
        application_id INT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await pool.query(
      `INSERT INTO admin_logs (admin_identifier, action, application_id, details)
       VALUES ($1, $2, $3, $4)`,
      ['admin', 'tapfiliate_sync', applicationId, `Affiliate ${affiliateId} synced to program ${TAPFILIATE_PROGRAM_ID}`]
    );
  } catch (err) {
    console.error('Error syncing Tapfiliate affiliate:', err);
  }
}

function requireAdmin(req, res, next) {
  const key = req.ip || 'global';
  const now = Date.now();
  const windowMs = 2 * 60 * 60 * 1000; // 2 hours

  if (!adminAttempts[key]) {
    adminAttempts[key] = { count: 0, lockedUntil: 0 };
  }

  const record = adminAttempts[key];

  if (record.lockedUntil && now < record.lockedUntil) {
    return res.status(429).json({
      success: false,
      message: 'Too many failed admin attempts. Access is locked for 2 hours.'
    });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token || token !== process.env.ADMIN_API_TOKEN) {
    record.count += 1;

    if (record.count >= 3) {
      record.lockedUntil = now + windowMs;
    }

    return res.status(401).json({ success: false, message: 'Unauthorized. Invalid admin token.' });
  }

  adminAttempts[key] = { count: 0, lockedUntil: 0 };

  next();
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Routes - pages
app.get('/partners', (req, res) => {
  res.sendFile(path.join(publicDir, 'partners.html'));
});

app.get('/partners/apply', (req, res) => {
  res.sendFile(path.join(publicDir, 'partners-apply.html'));
});

app.get('/partners/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'partners-admin.html'));
});

// API route - partner application (placeholder implementation)
app.post('/api/partner-application', async (req, res) => {
  const { name, email, whatsapp, country, audience, platform, motivation, termsAccepted } = req.body;

  if (!name || !email || !country || !motivation || !termsAccepted) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields.'
    });
  }

  try {
    const existing = await pool.query(
      'SELECT id FROM partner_applications WHERE email = $1 LIMIT 1',
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'This email has already been used for a partner application.'
      });
    }

    await pool.query(
      `CREATE TABLE IF NOT EXISTS partner_applications (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        whatsapp VARCHAR(50),
        country VARCHAR(100) NOT NULL,
        audience_size VARCHAR(50),
        platform VARCHAR(255),
        motivation TEXT NOT NULL,
        terms_accepted BOOLEAN DEFAULT false,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await pool.query(
      `INSERT INTO partner_applications
        (name, email, whatsapp, country, audience_size, platform, motivation, terms_accepted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        name,
        email,
        whatsapp || null,
        country,
        audience || null,
        platform || null,
        motivation,
        true
      ]
    );

    console.log('New partner application stored for:', email);

    // Fire-and-forget forwarding to landing waitlist; do not block or affect response on failure
    forwardEmailToLanding(email).catch((err) => {
      console.error('Unhandled waitlist forwarding error:', err);
    });

    return res.status(200).json({
      success: true,
      message: 'Application submitted successfully. We will review and get back to you.'
    });
  } catch (err) {
    console.error('Error saving partner application:', err);
    return res.status(500).json({
      success: false,
      message: 'Error saving application. Please try again later.'
    });
  }
});

app.get('/api/partner-applications/pending', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, whatsapp, country, audience_size, platform, motivation, status, created_at
       FROM partner_applications
       WHERE status = 'pending'
       ORDER BY created_at DESC`
    );

    return res.status(200).json({ success: true, applications: result.rows });
  } catch (err) {
    console.error('Error fetching pending applications:', err);
    return res.status(500).json({ success: false, message: 'Error fetching applications.' });
  }
});

app.get('/api/partner-applications/approved', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, whatsapp, country, audience_size, platform, motivation, status, created_at, approved_at
       FROM partner_applications
       WHERE status = 'approved'
       ORDER BY approved_at DESC NULLS LAST, created_at DESC`
    );

    return res.status(200).json({ success: true, applications: result.rows });
  } catch (err) {
    console.error('Error fetching approved applications:', err);
    return res.status(500).json({ success: false, message: 'Error fetching applications.' });
  }
});

app.get('/api/partner-applications/rejected', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, whatsapp, country, audience_size, platform, motivation, status, created_at, approved_at, notes
       FROM partner_applications
       WHERE status = 'rejected'
       ORDER BY approved_at DESC NULLS LAST, created_at DESC`
    );

    return res.status(200).json({ success: true, applications: result.rows });
  } catch (err) {
    console.error('Error fetching rejected applications:', err);
    return res.status(500).json({ success: false, message: 'Error fetching applications.' });
  }
});

app.post('/api/partner-applications/:id/approve', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query(
      `ALTER TABLE partner_applications
         ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
         ADD COLUMN IF NOT EXISTS approved_by VARCHAR(255),
         ADD COLUMN IF NOT EXISTS notes TEXT`
    );

    await pool.query(
      `UPDATE partner_applications
       SET status = 'approved', approved_at = NOW(), approved_by = $1
       WHERE id = $2`,
      ['admin', id]
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_identifier VARCHAR(255),
        action VARCHAR(50),
        application_id INT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await pool.query(
      `INSERT INTO admin_logs (admin_identifier, action, application_id, details)
       VALUES ($1, $2, $3, $4)`,
      ['admin', 'approve', id, null]
    );

    // Fire-and-forget Tapfiliate sync; do not block or affect response on failure
    syncTapfiliateAffiliate(id).catch((err) => {
      console.error('Unhandled Tapfiliate sync error:', err);
    });

    return res.status(200).json({ success: true, message: 'Partner application approved.' });
  } catch (err) {
    console.error('Error approving application:', err);
    return res.status(500).json({ success: false, message: 'Error approving application.' });
  }
});

app.post('/api/partner-applications/:id/reject', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};

  try {
    await pool.query(
      `ALTER TABLE partner_applications
         ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
         ADD COLUMN IF NOT EXISTS approved_by VARCHAR(255),
         ADD COLUMN IF NOT EXISTS notes TEXT`
    );

    await pool.query(
      `UPDATE partner_applications
       SET status = 'rejected', notes = $1
       WHERE id = $2`,
      [reason || null, id]
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_identifier VARCHAR(255),
        action VARCHAR(50),
        application_id INT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await pool.query(
      `INSERT INTO admin_logs (admin_identifier, action, application_id, details)
       VALUES ($1, $2, $3, $4)`,
      ['admin', 'reject', id, reason || null]
    );

    return res.status(200).json({ success: true, message: 'Partner application rejected.' });
  } catch (err) {
    console.error('Error rejecting application:', err);
    return res.status(500).json({ success: false, message: 'Error rejecting application.' });
  }
});

app.get('/api/admin-logs', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_identifier VARCHAR(255),
        action VARCHAR(50),
        application_id INT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    const result = await pool.query(
      `SELECT id, admin_identifier, action, application_id, details, created_at
       FROM admin_logs
       ORDER BY created_at DESC
       LIMIT 200`
    );

    return res.status(200).json({ success: true, logs: result.rows });
  } catch (err) {
    console.error('Error fetching admin logs:', err);
    return res.status(500).json({ success: false, message: 'Error fetching admin logs.' });
  }
});

app.listen(PORT, () => {
  console.log(`GIB Partnership server running on http://localhost:${PORT}`);
});
