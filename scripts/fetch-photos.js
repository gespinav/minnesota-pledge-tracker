#!/usr/bin/env node
/**
 * fetch-photos.js — pull official portraits for every tracked legislator.
 *
 * Sources (both are the members' own chamber, i.e. primary):
 *   House   https://www.house.mn.gov/hinfo/memberimgls94/<DIST>.gif   e.g. 01A, 45B
 *   Senate  https://www.senate.mn/graphics/<mem_bio_pic>              e.g. 35Abeler.jpg
 *           filenames come from https://www.senate.mn/api/members
 *
 * The originals are 200-500 KB apiece; at ~200 members that is ~60 MB, so each
 * one is resized to a 400px WebP (typically 15-25 KB) before it is written.
 *
 * Portraits are keyed by DISTRICT, but districts get reassigned every election —
 * so before saving anything we check the roster's name for that district against
 * the name we have. A mismatch means the seat changed hands and the photo would
 * be of the wrong person, so it is skipped and reported rather than written.
 *
 * Re-run after any election or roster change:  node scripts/fetch-photos.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { readRoster } = require('./lib/roster');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'public', 'index.html');
const OUT = path.join(ROOT, 'public', 'photos');
const SIZE = 400;

/**
 * Statewide executives are not on either chamber roster, and their offices'
 * sites sit behind bot protection that blocks scripted fetches. Drop a direct
 * image URL in here (or a local file path) and the next run will pick it up;
 * until then these five fall back to initials avatars in the UI.
 */
const EXEC_PHOTOS = {
  // 'exec-gov':   'https://…/walz.jpg',
  // 'exec-ltgov': 'https://…/flanagan.jpg',
  // 'exec-ag':    'https://…/ellison.jpg',
  // 'exec-sos':   'https://…/simon.jpg',
  // 'exec-aud':   'https://…/blaha.jpg',
};

// Strip accents, punctuation, case and honorifics so "Calvin K. Bahr" and "Cal
// Bahr" compare equal. Only the last name is used for the actual check.
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\b(jr|sr|ii|iii|iv|dr|mr|ms|mrs)\b/g, '')
  .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const lastName = s => { const p = norm(s).split(' ').filter(Boolean); return p[p.length - 1] || ''; };

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

/** district -> { name, url } for sitting senators. */
async function senateRoster() {
  const data = await getJSON('https://www.senate.mn/api/members');
  const map = new Map();
  for (const m of data.members || []) {
    if (!m.mem_bio_pic || !m.dist) continue;
    map.set(String(parseInt(m.dist, 10)), {
      name: m.preferred_full_name || m.preferred_last_name,
      url: `https://www.senate.mn/graphics/${m.mem_bio_pic}`,
    });
  }
  return map;
}

/** district -> { name, url } for sitting representatives. */
async function houseRoster() {
  const html = await getText('https://www.house.mn.gov/members/list');
  const map = new Map();
  // The portrait tag carries both facts we need: the district in its filename
  // (…/memberimgls94/45B.gif) and the member's name in its alt text
  // (alt="Rep. Patty Acomb  134" — a stray seat number trails the name).
  for (const m of html.matchAll(
    /memberimgls94\/(\d+[AB])\.gif[^>]*\salt="Rep\.?\s*([^"]+?)\s*\d*"/gi)) {
    const dist = m[1].toUpperCase();
    if (!map.has(dist)) map.set(dist, { name: m[2].trim(), url: `https://www.house.mn.gov/hinfo/memberimgls94/${dist}.gif` });
  }
  return map;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const html = fs.readFileSync(APP, 'utf8');
  const ours = readRoster(html);
  console.log(`Tracked legislators in app: ${ours.length}`);

  const [sen, house] = await Promise.all([senateRoster(), houseRoster()]);
  console.log(`Roster portraits available — senate: ${sen.size}, house: ${house.size}`);

  const manifest = {};
  const missing = [], mismatched = [], failed = [];
  let written = 0, bytes = 0;

  for (const o of ours) {
    let entry;
    if (o.chamber === 'executive') {
      if (!EXEC_PHOTOS[o.id]) { missing.push(`${o.id} ${o.name} (add a URL to EXEC_PHOTOS)`); continue; }
      entry = { name: o.name, url: EXEC_PHOTOS[o.id] };
    } else {
      entry = (o.chamber === 'senate' ? sen : house).get(o.dist);
      if (!entry) { missing.push(`${o.id} ${o.name}`); continue; }

      // Seat may have turned over since our data was captured — never attach a
      // portrait we cannot tie to the person we are actually showing.
      if (lastName(entry.name) !== lastName(o.name)) {
        mismatched.push(`${o.id} district ${o.dist}: app has "${o.name}", roster has "${entry.name}"`);
        continue;
      }
    }

    try {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const webp = await sharp(buf)
        .resize(SIZE, SIZE, { fit: 'cover', position: 'top' })  // portraits are head-and-shoulders; bias to the face
        .webp({ quality: 82 })
        .toBuffer();
      fs.writeFileSync(path.join(OUT, `${o.id}.webp`), webp);
      manifest[o.id] = { file: `photos/${o.id}.webp`, source: entry.url, name: entry.name };
      written++; bytes += webp.length;
    } catch (e) {
      failed.push(`${o.id} ${o.name}: ${e.message}`);
    }
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    generated: new Date().toISOString(),
    note: 'Official portraits from the members\' own chambers. Re-run scripts/fetch-photos.js to refresh.',
    photos: manifest,
  }, null, 2));

  console.log(`\nWrote ${written} portraits, ${(bytes / 1048576).toFixed(1)} MB total ` +
              `(avg ${Math.round(bytes / Math.max(written, 1) / 1024)} KB)`);
  const report = (label, arr) => { if (arr.length) console.log(`\n${label} (${arr.length}):\n  ` + arr.join('\n  ')); };
  report('No portrait on roster', missing);
  report('SKIPPED — name mismatch, seat likely changed hands', mismatched);
  report('Download/convert failed', failed);
}

main().catch(e => { console.error(e); process.exit(1); });
