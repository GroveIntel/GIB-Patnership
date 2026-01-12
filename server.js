require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const Stripe = require('stripe');

// Lazy node-fetch import so we can use fetch reliably in Node
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT;

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeSecretKey ? Stripe(stripeSecretKey) : null;

// Optional: forward new partner emails to existing landing waitlist endpoint
const LANDING_WAITLIST_URL = process.env.LANDING_WAITLIST_URL;

// Tapfiliate configuration
const TAPFILIATE_API_KEY = process.env.TAPFILIATE_API_KEY;
const TAPFILIATE_PROGRAM_ID = process.env.TAPFILIATE_PROGRAM_ID;

// Commission and fee configuration
const GLOBAL_COMMISSION_RATE = Number(process.env.PARTNER_COMMISSION_RATE || '0.35');
const STRIPE_FEE_PERCENT = Number(process.env.STRIPE_FEE_PERCENT || '0.029');
const STRIPE_FEE_FIXED = Number(process.env.STRIPE_FEE_FIXED || '0.30');

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

async function createTapfiliateAffiliateForEmail({ email, name }) {
  try {
    if (!TAPFILIATE_API_KEY || !TAPFILIATE_PROGRAM_ID) {
      console.warn('Tapfiliate not fully configured (missing API key or program id). Skipping automatic affiliate creation.');
      return;
    }

    if (!email) {
      console.warn('createTapfiliateAffiliateForEmail called without email, skipping');
      return;
    }

    await ensureV2Tables();

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
      console.error('Tapfiliate create affiliate from Stripe failed:', createRes.status, text);
      return;
    }

    const created = await createRes.json().catch(() => null);
    if (!created || !created.id) {
      console.error('Tapfiliate create affiliate from Stripe: missing id in response');
      return;
    }

    const affiliateId = created.id;

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
      console.error('Tapfiliate add affiliate from Stripe to program failed:', progRes.status, text);
      return;
    }

    await pool.query(
      `INSERT INTO partners (application_id, tapfiliate_affiliate_id)
       VALUES ($1, $2)
       ON CONFLICT (application_id) DO NOTHING`,
      [null, affiliateId]
    );
  } catch (err) {
    console.error('Error in createTapfiliateAffiliateForEmail:', err);
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

async function ensureV2Tables() {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS partners (
        id SERIAL PRIMARY KEY,
        application_id INT UNIQUE,
        tapfiliate_affiliate_id VARCHAR(255),
        trolley_recipient_id VARCHAR(255),
        tier VARCHAR(50) DEFAULT 'basic',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS partner_earnings (
        id SERIAL PRIMARY KEY,
        partner_id INT REFERENCES partners(id),
        period DATE NOT NULL,
        currency VARCHAR(10) NOT NULL,
        gross_revenue NUMERIC(12, 2) NOT NULL DEFAULT 0,
        net_revenue NUMERIC(12, 2) NOT NULL DEFAULT 0,
        commission_rate NUMERIC(5, 4) NOT NULL DEFAULT 0,
        commission_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
        source VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_earnings_partner_period_currency
       ON partner_earnings(partner_id, period, currency)`
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS partner_payouts (
        id SERIAL PRIMARY KEY,
        partner_id INT REFERENCES partners(id),
        amount NUMERIC(12, 2) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        method VARCHAR(50) NOT NULL DEFAULT 'trolley',
        period_start DATE,
        period_end DATE,
        trolley_payout_id VARCHAR(255),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );
  } catch (err) {
    console.error('Error ensuring v2 tables exist:', err);
  }
}

async function upsertPartnerEarnings({
  partnerId,
  period,
  currency,
  grossRevenue,
  netRevenue,
  commissionRate
}) {
  try {
    await ensureV2Tables();

    const rate = Number(commissionRate) || 0;
    const net = Number(netRevenue) || 0;
    const gross = Number(grossRevenue) || 0;
    const commissionAmount = net * rate;

    const result = await pool.query(
      `INSERT INTO partner_earnings (
         partner_id,
         period,
         currency,
         gross_revenue,
         net_revenue,
         commission_rate,
         commission_amount,
         source
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (partner_id, period, currency)
       DO UPDATE SET
         gross_revenue = EXCLUDED.gross_revenue,
         net_revenue = EXCLUDED.net_revenue,
         commission_rate = EXCLUDED.commission_rate,
         commission_amount = EXCLUDED.commission_amount,
         source = EXCLUDED.source
       RETURNING *`,
      [
        partnerId,
        period,
        currency,
        gross,
        net,
        rate,
        commissionAmount,
        'manual_test'
      ]
    );

    return result.rows[0];
  } catch (err) {
    console.error('Error upserting partner earnings:', err);
    throw err;
  }
}

async function syncPartnerEarningsFromTapfiliate(periodYm) {
  if (!TAPFILIATE_API_KEY || !TAPFILIATE_PROGRAM_ID) {
    throw new Error('Tapfiliate API not fully configured. Please set TAPFILIATE_API_KEY and TAPFILIATE_PROGRAM_ID.');
  }

  // Expect periodYm like '2025-01'
  if (!/^\d{4}-\d{2}$/.test(periodYm)) {
    throw new Error('Invalid period format. Expected YYYY-MM.');
  }

  const [yearStr, monthStr] = periodYm.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-12

  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1)); // first day of next month

  // Load partners with Tapfiliate affiliate IDs to map conversions -> partners
  await ensureV2Tables();

  const partnersRes = await pool.query(
    `SELECT id, tapfiliate_affiliate_id
     FROM partners
     WHERE tapfiliate_affiliate_id IS NOT NULL`
  );

  const affiliateToPartner = {};
  for (const row of partnersRes.rows) {
    if (row.tapfiliate_affiliate_id) {
      affiliateToPartner[String(row.tapfiliate_affiliate_id)] = row.id;
    }
  }

  // If no partners are wired to Tapfiliate yet, nothing to do
  if (Object.keys(affiliateToPartner).length === 0) {
    return { period: periodYm, totals: [], note: 'No partners with tapfiliate_affiliate_id found.' };
  }

  // Fetch conversions from Tapfiliate within the period. We keep pagination simple for now.
  const fromIso = periodStart.toISOString();
  const toIso = periodEnd.toISOString();

  const allConversions = [];

  for (let page = 1; page <= 5; page += 1) {
    const url = new URL('https://api.tapfiliate.com/1.6/conversions/');
    url.searchParams.set('program', TAPFILIATE_PROGRAM_ID);
    url.searchParams.set('from', fromIso);
    url.searchParams.set('to', toIso);
    url.searchParams.set('page', String(page));

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': TAPFILIATE_API_KEY
      }
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Tapfiliate conversions fetch failed:', res.status, text);
      throw new Error('Failed to fetch conversions from Tapfiliate.');
    }

    const pageData = await res.json().catch(() => []);
    if (!Array.isArray(pageData) || pageData.length === 0) {
      break;
    }

    allConversions.push(...pageData);

    // If results are less than a typical page size (default 50), we can assume we're done
    if (pageData.length < 50) {
      break;
    }
  }

  if (allConversions.length === 0) {
    return { period: periodYm, totals: [], note: 'No conversions found for this period.' };
  }

  // Aggregate by partner + currency
  const bucket = {};

  for (const conv of allConversions) {
    const affiliate = conv.affiliate || conv.affiliate_program || conv.affiliate_program_affiliate || null;
    const affiliateId = affiliate && (affiliate.id || affiliate.affiliate || affiliate.affiliate_id);

    if (!affiliateId) {
      continue;
    }

    const partnerId = affiliateToPartner[String(affiliateId)];
    if (!partnerId) {
      // Conversion for an affiliate we don't know about yet
      continue;
    }

    const gross = Number(conv.amount || conv.commission_amount || 0);
    if (!gross || Number.isNaN(gross) || gross <= 0) {
      continue;
    }

    const currency = (conv.currency || (conv.commission && conv.commission.currency) || 'usd').toLowerCase();

    // Estimate Stripe fees so we can calculate net
    const fee = gross * STRIPE_FEE_PERCENT + STRIPE_FEE_FIXED;
    const net = Math.max(gross - fee, 0);

    const key = `${partnerId}:${currency}`;
    if (!bucket[key]) {
      bucket[key] = {
        partnerId,
        currency,
        gross: 0,
        net: 0
      };
    }

    bucket[key].gross += gross;
    bucket[key].net += net;
  }

  const periodDate = `${periodYm}-01`;
  const totals = [];

  for (const key of Object.keys(bucket)) {
    const { partnerId, currency, gross, net } = bucket[key];

    const row = await upsertPartnerEarnings({
      partnerId,
      period: periodDate,
      currency,
      grossRevenue: gross,
      netRevenue: net,
      commissionRate: GLOBAL_COMMISSION_RATE
    });

    totals.push({
      partner_id: partnerId,
      currency,
      gross,
      net,
      commission_rate: GLOBAL_COMMISSION_RATE,
      commission_amount: row.commission_amount
    });
  }

  return { period: periodYm, totals };
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

// Stripe webhook for automatic partner creation on successful checkout
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) {
    return res.status(500).send('Stripe not configured');
  }

  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerDetails = session.customer_details || {};
    const email = customerDetails.email;
    const name = customerDetails.name;

    if (email) {
      try {
        await createTapfiliateAffiliateForEmail({ email, name });
      } catch (err) {
        console.error('Error creating Tapfiliate affiliate from Stripe webhook:', err);
      }
    }
  }

  res.json({ received: true });
});

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

app.post('/api/partner-earnings/sync', requireAdmin, async (req, res) => {
  try {
    const { period } = req.body || {};

    if (!period || typeof period !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'period (YYYY-MM) is required.'
      });
    }

    const summary = await syncPartnerEarningsFromTapfiliate(period);

    return res.status(200).json({ success: true, summary });
  } catch (err) {
    console.error('Error syncing partner earnings from Tapfiliate:', err);
    return res.status(500).json({ success: false, message: 'Error syncing partner earnings.' });
  }
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

    await ensureV2Tables();

    await pool.query(
      `INSERT INTO partners (application_id)
       VALUES ($1)
       ON CONFLICT (application_id) DO NOTHING`,
      [id]
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

app.post('/api/partner-earnings/test', requireAdmin, async (req, res) => {
  try {
    const {
      partner_id: partnerId,
      period,
      currency,
      gross_revenue: grossRevenue,
      net_revenue: netRevenue,
      commission_rate: commissionRate
    } = req.body || {};

    if (!partnerId || !period || !currency) {
      return res.status(400).json({
        success: false,
        message: 'partner_id, period, and currency are required.'
      });
    }

    const row = await upsertPartnerEarnings({
      partnerId,
      period,
      currency,
      grossRevenue,
      netRevenue,
      commissionRate
    });

    return res.status(200).json({ success: true, earnings: row });
  } catch (err) {
    console.error('Error creating test partner earnings:', err);
    return res.status(500).json({ success: false, message: 'Error creating test earnings.' });
  }
});

app.get('/api/partner-earnings', requireAdmin, async (req, res) => {
  try {
    await ensureV2Tables();

    const { period } = req.query || {};

    const params = [];
    let whereClause = '';

    if (period) {
      // Expect period like '2025-01'; compare year-month
      params.push(`${period}-01`);
      whereClause = 'WHERE pe.period = $1';
    }

    const result = await pool.query(
      `SELECT
         pe.id,
         pe.partner_id,
         pe.period,
         pe.currency,
         pe.gross_revenue,
         pe.net_revenue,
         pe.commission_rate,
         pe.commission_amount,
         pe.source,
         pe.created_at,
         p.tier,
         pa.name,
         pa.email,
         pa.country
       FROM partner_earnings pe
       JOIN partners p ON p.id = pe.partner_id
       LEFT JOIN partner_applications pa ON pa.id = p.application_id
       ${whereClause}
       ORDER BY pe.period DESC, pe.created_at DESC`,
      params
    );

    return res.status(200).json({ success: true, earnings: result.rows });
  } catch (err) {
    console.error('Error fetching partner earnings:', err);
    return res.status(500).json({ success: false, message: 'Error fetching partner earnings.' });
  }
});

app.get('/api/partners', requireAdmin, async (req, res) => {
  try {
    await ensureV2Tables();

    const result = await pool.query(
      `SELECT
         p.id,
         p.application_id,
         p.tapfiliate_affiliate_id,
         p.trolley_recipient_id,
         p.tier,
         p.created_at,
         pa.name,
         pa.email,
         pa.country
       FROM partners p
       LEFT JOIN partner_applications pa ON pa.id = p.application_id
       ORDER BY p.created_at DESC`
    );

    return res.status(200).json({ success: true, partners: result.rows });
  } catch (err) {
    console.error('Error fetching partners:', err);
    return res.status(500).json({ success: false, message: 'Error fetching partners.' });
  }
});

app.listen(PORT, () => {
  console.log(`GIB Partnership server running on http://localhost:${PORT}`);
});
