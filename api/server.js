#!/usr/bin/env node
/**
 * MN Elected Officials Scorecard API
 * ====================================
 * Express server providing:
 *  - REST API for all 206 MN officials
 *  - SQLite persistence for promises + votes
 *  - MN Legislature scraper integration
 *  - Automated scoring engine
 *  - Data validation layer
 *
 * Data sources (all public):
 *  - https://www.house.mn.gov/members/list
 *  - https://www.senate.mn/members
 *  - https://www.revisor.mn.gov/bills/status_search.php
 *  - https://mn.gov/governor/
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { EXECUTIVES, SENATORS, HOUSE_MEMBERS } = require('../data/officials');
const db = require('./db');
const crypto = require('crypto');
const app = express();
app.disable('x-powered-by');

// ─── Security configuration (via environment) ────────────────────────────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const IS_PROD = process.env.NODE_ENV === 'production';

// ─── Security headers (applied to every response) ────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
  // CSP tuned for this app: inline scripts/handlers are required; Google Fonts allowed; no eval.
  // Firebase Auth/Firestore + reCAPTCHA (App Check) hosts are allowed for cloud profiles.
  // Kept in sync with the <meta> CSP in public/index.html (which covers the standalone/file:// case).
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://www.google.com https://apis.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com https://*.cloudfunctions.net https://www.google.com https://apis.google.com https://accounts.google.com",
    "frame-src https://www.google.com https://apis.google.com https://accounts.google.com https://*.firebaseapp.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ─── CORS: same-origin by default; cross-origin only for explicitly allowed hosts ─
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                 // same-origin, curl, server-to-server
    if (ALLOWED_ORIGINS.length === 0) return cb(null, !IS_PROD); // dev: allow; prod: deny unless configured
    return cb(null, ALLOWED_ORIGINS.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  maxAge: 600,
}));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json({ limit: '256kb' }));

// ─── In-memory per-IP rate limiter (dependency-free) ─────────────────────────
const _rl = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    const now = Date.now();
    let b = _rl.get(ip);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; _rl.set(ip, b); }
    b.count++;
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - b.count));
    if (b.count > max) { res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000)); return res.status(429).json({ error: 'Too many requests. Please slow down.' }); }
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [ip, b] of _rl) if (now > b.reset) _rl.delete(ip); }, 60000).unref();
app.use('/api/', rateLimit({ windowMs: 60000, max: 240 }));            // reads: 240/min/IP
const writeLimiter = rateLimit({ windowMs: 60000, max: 30 });         // writes: 30/min/IP

// ─── Admin auth for all write (mutation) operations ──────────────────────────
// Requires header  Authorization: Bearer <ADMIN_TOKEN>  (or  X-Admin-Token: <ADMIN_TOKEN>).
// If ADMIN_TOKEN is unset the server runs in OPEN dev mode and warns loudly at startup.
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // dev mode (see startup warning)
  const provided = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(provided), b = Buffer.from(ADMIN_TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ error: 'Unauthorized: a valid admin token is required for write operations.' });
}

// ─── In-memory store (replace with SQLite/Postgres in production) ─────────────
let store = {
  officials: {},
  promises: {},   // officialId -> [{...}]
  votes: {},       // officialId -> [{...}]
  lastFetch: null,
  fetchLog: [],
};
// Build the base store from the curated seed (data/officials.js). Cloned so the
// admin-edit layer below never mutates the required module's objects.
function buildOfficialIndex() {
  const idx = {};
  [...EXECUTIVES, ...SENATORS, ...HOUSE_MEMBERS].forEach(o => {
    idx[o.id] = {
      ...o,
      chamber: o.chamber || (o.dist && String(o.dist).match(/^[0-9]+$/) ? 'senate' : o.dist ? 'house' : 'executive'),
    };
    store.promises[o.id] = (o.promises || []).map(p => ({ ...p }));
    store.votes[o.id] = (o.votes || []).map(v => ({ ...v }));
  });
  return idx;
}
store.officials = buildOfficialIndex();

// ─── SQLite persistence layer (admin-edit delta applied on top of the seed) ────
function deserPromise(r) {
  return { id: r.id, text: r.text, category: r.category, status: r.status, evidence: r.evidence,
    sourceUrl: r.source_url, dateVerified: r.date_verified, addedBy: r.added_by, addedAt: r.added_at, updatedAt: r.updated_at };
}
function deserVote(r) {
  let a = null;
  try { a = r.aligned_with_promise == null ? null : JSON.parse(r.aligned_with_promise); } catch (e) { a = r.aligned_with_promise; }
  return { id: r.id, billNumber: r.bill_number, billTitle: r.bill_title, billCategory: r.bill_category,
    voteDate: r.vote_date, voteValue: r.vote_value, alignedWithPromise: a, sourceUrl: r.source_url,
    addedBy: r.added_by, addedAt: r.added_at, note: r.note, updatedAt: r.updated_at };
}
function upsertInArray(arr, item) {
  const i = arr.findIndex(x => x.id === item.id);
  if (i === -1) arr.push(item); else arr[i] = item;
}
(function loadPersistedDeltas() {
  const del = db.prepare('SELECT id, kind FROM deletions').all();
  const delP = new Set(del.filter(d => d.kind === 'promise').map(d => d.id));
  const delV = new Set(del.filter(d => d.kind === 'vote').map(d => d.id));
  if (delP.size) for (const oid in store.promises) store.promises[oid] = store.promises[oid].filter(p => !delP.has(p.id));
  if (delV.size) for (const oid in store.votes) store.votes[oid] = store.votes[oid].filter(v => !delV.has(v.id));
  let np = 0, nv = 0;
  db.prepare('SELECT * FROM promises').all().forEach(r => {
    if (!store.officials[r.official_id]) return;
    store.promises[r.official_id] = store.promises[r.official_id] || [];
    upsertInArray(store.promises[r.official_id], deserPromise(r)); np++;
  });
  db.prepare('SELECT * FROM votes').all().forEach(r => {
    if (!store.officials[r.official_id]) return;
    store.votes[r.official_id] = store.votes[r.official_id] || [];
    upsertInArray(store.votes[r.official_id], deserVote(r)); nv++;
  });
  console.log(`📦 Applied persisted admin edits: ${np} promises, ${nv} votes, ${del.length} deletions from SQLite`);
})();

const stmtPutPromise = db.prepare(`INSERT OR REPLACE INTO promises
  (id, official_id, text, category, status, evidence, source_url, date_verified, added_by, added_at, updated_at)
  VALUES (@id,@official_id,@text,@category,@status,@evidence,@source_url,@date_verified,@added_by,@added_at,@updated_at)`);
const stmtPutVote = db.prepare(`INSERT OR REPLACE INTO votes
  (id, official_id, bill_number, bill_title, bill_category, vote_date, vote_value, aligned_with_promise, source_url, added_by, added_at, note, updated_at)
  VALUES (@id,@official_id,@bill_number,@bill_title,@bill_category,@vote_date,@vote_value,@aligned_with_promise,@source_url,@added_by,@added_at,@note,@updated_at)`);
const stmtDelPromiseRow = db.prepare('DELETE FROM promises WHERE id=?');
const stmtDelVoteRow = db.prepare('DELETE FROM votes WHERE id=?');
const stmtTombstone = db.prepare('INSERT OR REPLACE INTO deletions (id, kind) VALUES (?, ?)');
const stmtUntombstone = db.prepare('DELETE FROM deletions WHERE id=?');
function persistPromise(oid, p) {
  stmtPutPromise.run({ id: p.id, official_id: oid, text: p.text ?? null, category: p.category ?? null, status: p.status ?? null,
    evidence: p.evidence ?? null, source_url: p.sourceUrl ?? null, date_verified: p.dateVerified ?? null,
    added_by: p.addedBy ?? null, added_at: p.addedAt ?? null, updated_at: p.updatedAt ?? null });
  stmtUntombstone.run(p.id);
}
function persistVote(oid, v) {
  stmtPutVote.run({ id: v.id, official_id: oid, bill_number: v.billNumber ?? null, bill_title: v.billTitle ?? null,
    bill_category: v.billCategory ?? null, vote_date: v.voteDate ?? null, vote_value: v.voteValue ?? null,
    aligned_with_promise: v.alignedWithPromise === undefined ? null : JSON.stringify(v.alignedWithPromise),
    source_url: v.sourceUrl ?? null, added_by: v.addedBy ?? null, added_at: v.addedAt ?? null, note: v.note ?? null, updated_at: v.updatedAt ?? null });
  stmtUntombstone.run(v.id);
}
function deletePromisePersist(id) { stmtDelPromiseRow.run(id); stmtTombstone.run(id, 'promise'); }
function deleteVotePersist(id) { stmtDelVoteRow.run(id); stmtTombstone.run(id, 'vote'); }

// ─── Scoring Engine ────────────────────────────────────────────────────────────
function computeScore(officialId) {
  const promises = store.promises[officialId] || [];
  const votes = store.votes[officialId] || [];

  // Promise score
  const scoredPromises = promises.filter(p => p.status !== 'pending' && p.status !== 'unknown');
  let promiseScore = null;
  if (scoredPromises.length > 0) {
    const total = scoredPromises.reduce((acc, p) => {
      if (p.status === 'kept') return acc + 1.0;
      if (p.status === 'partial') return acc + 0.5;
      if (p.status === 'broken') return acc + 0.0;
      return acc;
    }, 0);
    promiseScore = Math.round((total / scoredPromises.length) * 100);
  }

  // Vote alignment score
  // A vote is "tagged" if alignedWithPromise is non-empty; "aligned" if it is true, 'true',
  // or a promise ID (string starting 'p-'). Matches the web app's computeScore convention.
  const scoredVotes = votes.filter(v => v.alignedWithPromise !== null && v.alignedWithPromise !== undefined && v.alignedWithPromise !== '');
  let voteAlign = null;
  if (scoredVotes.length > 0) {
    const aligned = scoredVotes.filter(v => { const a = v.alignedWithPromise; return a === true || a === 'true' || (typeof a === 'string' && a.startsWith('p-')); }).length;
    voteAlign = Math.round((aligned / scoredVotes.length) * 100);
  }

  // Composite
  let composite = null;
  if (promiseScore !== null && voteAlign !== null) {
    composite = Math.round((promiseScore * 0.5) + (voteAlign * 0.5));
  } else if (promiseScore !== null) {
    composite = promiseScore;
  } else if (voteAlign !== null) {
    composite = voteAlign;
  }

  const grade = composite !== null
    ? composite >= 90 ? 'A' : composite >= 75 ? 'B' : composite >= 60 ? 'C' : composite >= 45 ? 'D' : 'F'
    : 'N/A';

  return {
    promiseScore,
    voteAlign,
    composite,
    grade,
    promiseCount: promises.length,
    scoredPromiseCount: scoredPromises.length,
    voteCount: votes.length,
    breakdown: {
      kept: promises.filter(p => p.status === 'kept').length,
      partial: promises.filter(p => p.status === 'partial').length,
      broken: promises.filter(p => p.status === 'broken').length,
      pending: promises.filter(p => p.status === 'pending' || p.status === 'unknown').length,
    }
  };
}

// ─── MN Legislature Scraper / Fetcher ─────────────────────────────────────────
/**
 * Fetches roll call votes from MN Legislature for a given bill.
 * Real integration: revisor.mn.gov has machine-readable data.
 * This function shows the integration pattern — in production,
 * replace the mock with actual HTTP fetches to:
 *   https://www.revisor.mn.gov/bills/status_search.php?body=House
 *   https://www.revisor.mn.gov/bills/status_search.php?body=Senate
 */
async function fetchBillVotes(billNumber, chamber = 'House', session = '2025-2026') {
  const url = `https://www.revisor.mn.gov/bills/bill.php?b=${chamber === 'House' ? 'HF' : 'SF'}${billNumber}&f=&ssn=0&y=2025`;

  try {
    // In production: parse HTML from revisor.mn.gov
    // The MN Legislature publishes roll calls at:
    //   https://www.house.mn.gov/cco/journals/journl.htm  (House Journal PDFs)
    //   https://www.senate.mn/journals/journal_list.php    (Senate Journal PDFs)

    const logEntry = {
      timestamp: new Date().toISOString(),
      action: 'fetch_bill_votes',
      billNumber,
      chamber,
      url,
      status: 'attempted',
      note: 'Live fetch requires running server with network access to revisor.mn.gov'
    };
    store.fetchLog.push(logEntry);

    return {
      success: false,
      message: 'Live fetch not available in demo mode. Deploy server with network access to revisor.mn.gov to activate.',
      url,
      instructions: [
        '1. GET ' + url,
        '2. Parse roll call table from HTML',
        '3. Match member names to official IDs',
        '4. Store votes in database',
        '5. Flag for manual alignment tagging',
      ]
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Fetches current bill list from MN House or Senate
 */
async function fetchRecentBills(chamber = 'House', limit = 50) {
  const searchUrl = `https://www.revisor.mn.gov/bills/status_search.php?body=${chamber}`;
  return {
    source: searchUrl,
    chamber,
    instructions: 'Use this URL to search for bills and retrieve roll call data.',
    dataFields: ['bill_number','title','status','introduced_date','last_action','chief_author'],
    rollCallUrl: `https://www.revisor.mn.gov/bills/status_search.php?body=${chamber}`,
  };
}

// ─── Data Validation Layer ─────────────────────────────────────────────────────
function validatePromise(data) {
  const errors = [];
  if (!data.text || data.text.trim().length < 10) errors.push('Promise text must be at least 10 characters');
  if (!data.category) errors.push('Category is required');
  if (!['kept','partial','broken','pending','unknown'].includes(data.status)) errors.push('Invalid status');
  if (data.sourceUrl && !data.sourceUrl.startsWith('http')) errors.push('Source URL must start with http');
  if (data.dateVerified && !/^\d{4}-\d{2}-\d{2}$/.test(data.dateVerified)) errors.push('Date must be YYYY-MM-DD format');
  return errors;
}

function validateVote(data) {
  const errors = [];
  if (!data.billNumber) errors.push('Bill number is required');
  if (!data.billTitle || data.billTitle.trim().length < 5) errors.push('Bill title is required');
  if (!['yea','nay','absent','excused'].includes(data.voteValue)) errors.push('Invalid vote value');
  if (data.alignedWithPromise != null && typeof data.alignedWithPromise !== 'boolean' && typeof data.alignedWithPromise !== 'string') errors.push('alignedWithPromise must be boolean, promise-ID string, or null');
  return errors;
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    totalOfficials: Object.keys(store.officials).length,
    lastFetch: store.lastFetch,
    dataValidationEnabled: true,
  });
});

// Get all officials (with computed scores)
app.get('/api/officials', (req, res) => {
  const { chamber, party, search, grade, minScore } = req.query;
  let results = Object.values(store.officials).map(o => ({
    ...o,
    score: computeScore(o.id),
    promiseCount: (store.promises[o.id] || []).length,
    voteCount: (store.votes[o.id] || []).length,
  }));

  if (chamber) results = results.filter(o => o.chamber === chamber);
  if (party) results = results.filter(o => o.party === party);
  if (grade && grade !== 'all') results = results.filter(o => o.score.grade === grade);
  if (minScore) results = results.filter(o => o.score.composite !== null && o.score.composite >= parseInt(minScore));
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(o =>
      o.name.toLowerCase().includes(q) ||
      (o.city || '').toLowerCase().includes(q) ||
      (o.dist ? String(o.dist) : '').includes(q) ||
      (o.office || '').toLowerCase().includes(q)
    );
  }

  res.json({ count: results.length, data: results });
});

// Get single official
app.get('/api/officials/:id', (req, res) => {
  const official = store.officials[req.params.id];
  if (!official) return res.status(404).json({ error: 'Official not found' });
  res.json({
    ...official,
    score: computeScore(official.id),
    promises: store.promises[official.id] || [],
    votes: store.votes[official.id] || [],
  });
});

// Get promises for official
app.get('/api/officials/:id/promises', (req, res) => {
  if (!store.officials[req.params.id]) return res.status(404).json({ error: 'Official not found' });
  res.json(store.promises[req.params.id] || []);
});

// Add promise
app.post('/api/officials/:id/promises', writeLimiter, requireAdmin, (req, res) => {
  if (!store.officials[req.params.id]) return res.status(404).json({ error: 'Official not found' });
  const errors = validatePromise(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const promise = {
    id: `p-${Date.now()}-${Math.random().toString(36).substr(2,6)}`,
    ...req.body,
    addedAt: new Date().toISOString(),
    addedBy: req.body.addedBy || 'admin',
  };
  if (!store.promises[req.params.id]) store.promises[req.params.id] = [];
  store.promises[req.params.id].push(promise);
  persistPromise(req.params.id, promise);
  res.status(201).json(promise);
});

// Update promise
app.put('/api/officials/:id/promises/:pid', writeLimiter, requireAdmin, (req, res) => {
  const promises = store.promises[req.params.id];
  if (!promises) return res.status(404).json({ error: 'Official not found' });
  const idx = promises.findIndex(p => p.id === req.params.pid);
  if (idx === -1) return res.status(404).json({ error: 'Promise not found' });
  const errors = validatePromise({ ...promises[idx], ...req.body });
  if (errors.length) return res.status(400).json({ errors });
  promises[idx] = { ...promises[idx], ...req.body, updatedAt: new Date().toISOString() };
  persistPromise(req.params.id, promises[idx]);
  res.json(promises[idx]);
});

// Delete promise
app.delete('/api/officials/:id/promises/:pid', writeLimiter, requireAdmin, (req, res) => {
  const promises = store.promises[req.params.id];
  if (!promises) return res.status(404).json({ error: 'Official not found' });
  const idx = promises.findIndex(p => p.id === req.params.pid);
  if (idx === -1) return res.status(404).json({ error: 'Promise not found' });
  promises.splice(idx, 1);
  deletePromisePersist(req.params.pid);
  res.json({ deleted: true });
});

// Get votes for official
app.get('/api/officials/:id/votes', (req, res) => {
  if (!store.officials[req.params.id]) return res.status(404).json({ error: 'Official not found' });
  res.json(store.votes[req.params.id] || []);
});

// Add vote record
app.post('/api/officials/:id/votes', writeLimiter, requireAdmin, (req, res) => {
  if (!store.officials[req.params.id]) return res.status(404).json({ error: 'Official not found' });
  const errors = validateVote(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const vote = {
    id: `v-${Date.now()}-${Math.random().toString(36).substr(2,6)}`,
    ...req.body,
    addedAt: new Date().toISOString(),
  };
  if (!store.votes[req.params.id]) store.votes[req.params.id] = [];
  store.votes[req.params.id].push(vote);
  persistVote(req.params.id, vote);
  res.status(201).json(vote);
});

// Update vote
app.put('/api/officials/:id/votes/:vid', writeLimiter, requireAdmin, (req, res) => {
  const votes = store.votes[req.params.id];
  if (!votes) return res.status(404).json({ error: 'Official not found' });
  const idx = votes.findIndex(v => v.id === req.params.vid);
  if (idx === -1) return res.status(404).json({ error: 'Vote not found' });
  votes[idx] = { ...votes[idx], ...req.body, updatedAt: new Date().toISOString() };
  persistVote(req.params.id, votes[idx]);
  res.json(votes[idx]);
});

// Delete vote
app.delete('/api/officials/:id/votes/:vid', writeLimiter, requireAdmin, (req, res) => {
  const votes = store.votes[req.params.id];
  if (!votes) return res.status(404).json({ error: 'Official not found' });
  const idx = votes.findIndex(v => v.id === req.params.vid);
  if (idx === -1) return res.status(404).json({ error: 'Vote not found' });
  votes.splice(idx, 1);
  deleteVotePersist(req.params.vid);
  res.json({ deleted: true });
});

// Bulk import votes for a bill (e.g., from MN Legislature roll call)
app.post('/api/votes/bulk-import', writeLimiter, requireAdmin, (req, res) => {
  const { billNumber, billTitle, billCategory, voteDate, chamber, rollCall, sourceUrl } = req.body;
  if (!billNumber || !rollCall || !Array.isArray(rollCall)) {
    return res.status(400).json({ error: 'billNumber and rollCall array required' });
  }
  const results = { added: 0, skipped: 0, errors: [] };
  rollCall.forEach(item => {
    const { officialId, name, voteValue } = item;
    let id = officialId;

    // Try name matching if no ID provided
    if (!id && name) {
      const match = Object.values(store.officials).find(o =>
        o.name.toLowerCase() === name.toLowerCase()
      );
      if (match) id = match.id;
    }

    if (!id || !store.officials[id]) {
      results.errors.push({ name, reason: 'Official not found' });
      results.skipped++;
      return;
    }

    const vote = {
      id: `v-${Date.now()}-${Math.random().toString(36).substr(2,6)}`,
      billNumber, billTitle, billCategory: billCategory || 'Other',
      voteDate, voteValue, sourceUrl,
      alignedWithPromise: null, // Requires manual tagging
      addedAt: new Date().toISOString(),
      importedVia: 'bulk-import'
    };
    if (!store.votes[id]) store.votes[id] = [];
    store.votes[id].push(vote);
    persistVote(id, vote);
    results.added++;
  });

  res.json(results);
});

// Get score for official
app.get('/api/officials/:id/score', (req, res) => {
  if (!store.officials[req.params.id]) return res.status(404).json({ error: 'Official not found' });
  res.json(computeScore(req.params.id));
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const { chamber, party, limit = 20 } = req.query;
  let officials = Object.values(store.officials).filter(o => !o.former).map(o => ({
    id: o.id, name: o.name, party: o.party, chamber: o.chamber,
    dist: o.dist, city: o.city, office: o.office,
    score: computeScore(o.id)
  })).filter(o => o.score.composite !== null);

  if (chamber) officials = officials.filter(o => o.chamber === chamber);
  if (party) officials = officials.filter(o => o.party === party);

  officials.sort((a, b) => b.score.composite - a.score.composite);
  res.json({ count: officials.length, data: officials.slice(0, parseInt(limit)) });
});

// Statistics
app.get('/api/stats', (req, res) => {
  const all = Object.values(store.officials).filter(o => !o.former);
  const graded = all.filter(o => computeScore(o.id).grade !== 'N/A');

  res.json({
    totalOfficials: all.length,
    byParty: {
      DFL: all.filter(o => o.party === 'DFL').length,
      R: all.filter(o => o.party === 'R').length,
    },
    byChamber: {
      executive: all.filter(o => o.chamber === 'executive').length,
      senate: all.filter(o => o.chamber === 'senate').length,
      house: all.filter(o => o.chamber === 'house').length,
    },
    graded: graded.length,
    totalPromises: Object.values(store.promises).flat().length,
    totalVotes: Object.values(store.votes).flat().length,
    gradeDistribution: ['A','B','C','D','F','N/A'].reduce((acc, g) => {
      acc[g] = all.filter(o => computeScore(o.id).grade === g).length;
      return acc;
    }, {}),
  });
});

// MN Legislature data fetchers
app.get('/api/fetch/bills', async (req, res) => {
  const { chamber = 'House' } = req.query;
  const data = await fetchRecentBills(chamber);
  res.json(data);
});

app.get('/api/fetch/votes/:billNumber', async (req, res) => {
  const { chamber = 'House' } = req.query;
  const data = await fetchBillVotes(req.params.billNumber, chamber);
  res.json(data);
});

app.get('/api/fetch/log', (req, res) => {
  res.json(store.fetchLog.slice(-100));
});

// Export data as JSON
app.get('/api/export', (req, res) => {
  const exportData = Object.values(store.officials).map(o => ({
    ...o,
    promises: store.promises[o.id] || [],
    votes: store.votes[o.id] || [],
    score: computeScore(o.id),
  }));
  res.setHeader('Content-Disposition', 'attachment; filename="mn-officials-export.json"');
  res.json(exportData);
});

// ─── 404 + global error handler (never leak stack traces) ────────────────────
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err && /CORS/.test(String(err.message))) return res.status(403).json({ error: 'Origin not allowed' });
  console.error('[error]', req.method, req.path, '-', err && err.message);
  res.status(err && err.status || 500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🏛  MN Officials Scorecard API`);
  console.log(`   Running at http://localhost:${PORT}`);
  console.log(`   ${Object.keys(store.officials).length} officials loaded`);
  // Security posture summary
  if (!ADMIN_TOKEN) console.warn(`\n   ⚠️  SECURITY: ADMIN_TOKEN is not set — write endpoints are OPEN. Set ADMIN_TOKEN before deploying.`);
  else console.log(`   🔒 Write endpoints require an admin token.`);
  if (ALLOWED_ORIGINS.length) console.log(`   🔒 CORS restricted to: ${ALLOWED_ORIGINS.join(', ')}`);
  else if (IS_PROD) console.warn(`   ⚠️  SECURITY: ALLOWED_ORIGINS not set in production — cross-origin requests are denied by default.`);
  console.log(`\n   Endpoints:`);
  console.log(`   GET  /api/officials         - All officials + scores`);
  console.log(`   GET  /api/officials/:id     - Single official`);
  console.log(`   POST /api/officials/:id/promises  - Add promise  (admin)`);
  console.log(`   POST /api/officials/:id/votes     - Add vote     (admin)`);
  console.log(`   POST /api/votes/bulk-import       - Import roll call (admin)`);
  console.log(`   GET  /api/leaderboard       - Ranked by score`);
  console.log(`   GET  /api/stats             - Aggregate statistics`);
  console.log(`   GET  /api/export            - Full JSON export\n`);
});

module.exports = app;
