#!/usr/bin/env node
/**
 * fetch-bios.js — build sourced biographies for every sitting legislator.
 *
 * Source: the Legislature's own "Legislators Past & Present" database
 *   roster  https://www.lrl.mn.gov/legdb/current
 *   record  https://www.lrl.mn.gov/legdb/fulldetail?id=<lrlId>
 *
 * Those records are consistently labelled, so everything here is parsed
 * deterministically from named fields — nothing is inferred, summarised by a
 * model, or written from memory. A field that is absent from the record is
 * absent from the profile; the UI then renders an honest "not researched"
 * state rather than filler.
 *
 * WHAT IS DELIBERATELY NOT EXTRACTED
 * The LRL record also carries date of birth, birthplace, gender, religion and
 * a "Reported Minority" field. This app is a scorecard of people's conduct in
 * public office, and none of those belong on such a profile. The parser only
 * reads public-sector career data: offices held, prior government service,
 * occupation, education, committees and leadership posts. The free-text
 * "General Notes" block is skipped too — it is inconsistent and sometimes
 * restates exactly the personal details above.
 *
 * VERIFICATION
 * Records are keyed by LRL id, which we resolve from the roster by district.
 * Districts get reassigned at every election, so before accepting a record we
 * check that the roster's name for that district matches the name we hold. A
 * mismatch means the seat changed hands and the record would describe the
 * wrong person — those are skipped and reported, never guessed at.
 * Every generated entry records the exact URL it was built from, and a full
 * field-by-field dump is written to scripts/bios-audit.json for spot-checking.
 *
 * Usage:  node scripts/fetch-bios.js          (uses cache where present)
 *         node scripts/fetch-bios.js --fresh  (re-downloads every record)
 */
const fs = require('fs');
const path = require('path');
const { readRoster, FORMER_LRL_IDS } = require('./lib/roster');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'public', 'index.html');
const CACHE = path.join(ROOT, '.lrl-cache');
const AUDIT = path.join(__dirname, 'bios-audit.json');
const FRESH = process.argv.includes('--fresh');
const VERIFIED = new Date().toISOString().slice(0, 10);
const POLITE_MS = 300;   // be a considerate guest on a public library server

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\b(jr|sr|ii|iii|iv|dr|mr|ms|mrs)\b/g, '')
  .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const lastName = s => { const p = norm(s).split(' ').filter(Boolean); return p[p.length - 1] || ''; };
/** LRL record titles are "Last, First" (and may carry a nickname: 'Rehm, Lucille "Lucy"'). */
const recordSurname = s => norm(String(s).split(',')[0]).split(' ').filter(Boolean).pop() || '';

/** Fetch with an on-disk cache so re-runs cost nothing and stay reproducible. */
async function getCached(url, key) {
  const file = path.join(CACHE, key + '.html');
  if (!FRESH && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const text = await r.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  await sleep(POLITE_MS);
  return text;
}

/** Flatten a record page to visible text lines — the labels we parse are line-based. */
function toLines(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  t = t.replace(/<[^>]+>/g, '\n');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, '’');
  return t.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Lines between a heading and the next all-caps section heading. */
const SECTIONS = ['BIOGRAPHICAL INFORMATION', 'EDUCATION', 'OTHER GOVERNMENT SERVICE',
                  'FAMILY RELATIONSHIPS', 'GENERAL NOTES', 'SESSIONS SERVED'];
function section(lines, name) {
  const i = lines.indexOf(name);
  if (i === -1) return [];
  let end = lines.length;
  for (let j = i + 1; j < lines.length; j++) {
    if (SECTIONS.includes(lines[j])) { end = j; break; }
  }
  return lines.slice(i + 1, end);
}
/** Value on the line following a "Label:" line. */
function labelled(lines, label) {
  const i = lines.indexOf(label);
  if (i === -1 || i + 1 >= lines.length) return '';
  const v = lines[i + 1];
  return (v.endsWith(':') || SECTIONS.includes(v)) ? '' : v;   // label with no value
}

// ── Roster ────────────────────────────────────────────────────────────────
/** district -> { name, chamber, lrlId } for everyone currently seated. */
async function roster() {
  const html = await getCached('https://www.lrl.mn.gov/legdb/current', 'roster');
  const map = new Map();
  const re = /fulldetail\?id=(\d+)'><b>(Rep\.|Sen\.)\s*([^<]+?)<\/b>[\s\S]{0,200}?District:\s*([0-9]+[AB]?)/gi;
  for (const m of html.matchAll(re)) {
    const chamber = m[2].toLowerCase() === 'rep.' ? 'house' : 'senate';
    // House districts carry a letter (45B); Senate districts are numeric and we
    // key them unpadded ("35") to match the app's sen-<n> ids.
    const dist = chamber === 'house' ? m[4].toUpperCase() : String(parseInt(m[4], 10));
    map.set(chamber + ':' + dist, { name: m[3].trim(), chamber, lrlId: m[1] });
  }
  return map;
}

/**
 * Someone we track who is not on the current roster — most often a member who
 * resigned or retired mid-term. Look them up by name and accept the record only
 * if its service history actually covers the district we hold for them, so we
 * cannot pick up a same-surnamed legislator from another seat.
 * Returns the id plus a flag so the caller can report the roster discrepancy.
 */
async function findDeparted(o) {
  const html = await getCached(
    'https://www.lrl.mn.gov/legdb/results?search=name&name=' + encodeURIComponent(lastName(o.name)),
    'search-' + lastName(o.name));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const m of html.matchAll(/fulldetail\.aspx\?ID=(\d+)/gi)) {
    const idx = text.indexOf(`District ${o.dist}`);
    if (idx === -1) continue;
    // The results table lists "Surname, First   House 2023-2026 (District 21A)".
    const around = text.slice(Math.max(0, idx - 400), idx + 100);
    if (recordSurname(o.name.split(' ').slice(-1)[0]) && around.toLowerCase().includes(lastName(o.name)))
      return m[1];
  }
  return null;
}

/** Names the app already records as former members, from its FORMER map. */
function knownFormer(html) {
  const block = html.match(/const FORMER\s*=\s*\{([\s\S]*?)\n  \};/);
  if (!block) return new Set();
  return new Set([...block[1].matchAll(/^\s*'([^']+)'\s*:\s*\{/gm)].map(m => m[1]));
}

// ── Record parsing ────────────────────────────────────────────────────────

/**
 * "House 2019-2022 (District 44B); House 2023-Present (District 45B)"
 * Long-serving members also appear with an abbreviated end year — Greg Davids'
 * record opens "House 1991-92 (District 32B)" — so two-digit ends are accepted
 * and expanded against the century of the start year.
 */
function parseService(lines) {
  // A few records carry stray text between the chamber and the years — a member
  // seated part-way through 2026 reads "House -Present 2026-Present (District 64A)"
  // — so skip anything up to the year range, anchored on the district that follows.
  const line = lines.find(l => /^(House|Senate)\s.*\(District\s*[0-9]+[AB]?\)/i.test(l));
  if (!line) return [];
  const out = [];
  let chamber = '';
  for (const part of line.split(';')) {
    // Read the chamber and the years independently. Folding both into one
    // pattern is what broke this before: with the chamber optional, the lazy
    // filler could skip straight past a real "Senate" label, so senators who had
    // also served in the House had their Senate terms silently relabelled.
    const c = part.match(/\b(House|Senate)\b/i);
    if (c) chamber = c[1].charAt(0).toUpperCase() + c[1].slice(1).toLowerCase();
    // Later spans sometimes omit the chamber and simply continue the previous
    // one — Tim O'Driscoll's record ends "…2013-2022 (District 13B); 2023-Present
    // (District 13B)". Dropping those truncates a sitting member's service, so
    // inherit the chamber only when the span genuinely does not name one.
    if (!chamber) continue;
    const m = part.match(/(\d{4})\s*-\s*(\d{2,4}|Present)\s*\(District\s*([0-9]+[AB]?)\)/i);
    if (!m) continue;
    let end = m[2];
    if (/^\d{2}$/.test(end)) end = m[1].slice(0, 2) + end;   // 1991-92 -> 1992
    out.push({ chamber, start: m[1], end, dist: m[3].toUpperCase() });
  }

  // Completeness guard. Every span in the line names a district, so the number
  // parsed must equal the number of "(District …)" markers. Fewer means the
  // format drifted again and we are about to publish a truncated career.
  const expected = (line.match(/\(District\s*[0-9]+[AB]?\)/gi) || []).length;
  if (out.length !== expected) {
    const err = new Error(`parsed ${out.length} of ${expected} service spans from: ${line}`);
    err.incompleteService = true;
    throw err;
  }
  return out;
}

/** "University of Minnesota; B.S.; Natural Resources, 1984" */
function parseEducation(lines) {
  const out = [];
  for (const l of section(lines, 'EDUCATION')) {
    if (l.startsWith('[') || l === 'Click to view') continue;
    const parts = l.split(';').map(p => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    const school = parts[0];
    const level = parts[1] || '';
    let field = parts.slice(2).join(', ').trim();
    let year = '';
    const ym = field.match(/,?\s*((?:\d{4})(?:\s*-\s*\d{4})?)\s*$/);
    if (ym) { year = ym[1].trim(); field = field.slice(0, ym.index).replace(/,\s*$/, '').trim(); }
    // "Secondary; 1985" puts the year in the level slot instead
    if (!year && /^\d{4}$/.test(level.trim())) { year = level.trim(); }
    const degree = [level && !/^\d{4}$/.test(level) ? level : '', field].filter(Boolean).join(', ');
    out.push({ school, degree, year });
  }
  return out;
}

/**
 * "OTHER GOVERNMENT SERVICE" entries arrive as:
 *   School Board/Administration:      <- category label
 *   ROCORI School District (School Board)
 *   ;
 *   2007 to 12/31/2018
 *   [Elected]                          <- optional
 */
function parseGovService(lines) {
  const sec = section(lines, 'OTHER GOVERNMENT SERVICE');
  const out = [];
  for (let i = 0; i < sec.length; i++) {
    if (!/:$/.test(sec[i])) continue;
    const category = sec[i].replace(/:$/, '').trim();
    const org = sec[i + 1];
    if (!org || org === ';' || /:$/.test(org)) continue;
    let dates = '', how = '';
    if (sec[i + 2] === ';' && sec[i + 3] && !/:$/.test(sec[i + 3])) dates = sec[i + 3];
    const after = sec[i + 4];
    if (after && /^\[(Elected|Appointed)\]$/i.test(after)) how = after.replace(/[\[\]]/g, '');
    if (/dates unknown/i.test(dates)) dates = '';
    out.push({ category, org, dates, how });
  }
  return out;
}

/** Committees and leadership from the most recent session block. */
function parseCurrentSession(lines) {
  const start = lines.indexOf('SESSIONS SERVED');
  if (start === -1) return { committees: [], leadership: [], sessionLabel: '' };
  const isSessionHeader = l => /^\d+(st|nd|rd|th) Legislative Session/.test(l);
  let blockEnd = lines.length;
  const sessionLabel = lines[start + 1] && isSessionHeader(lines[start + 1]) ? lines[start + 1] : '';
  for (let j = start + 2; j < lines.length; j++) {
    if (isSessionHeader(lines[j])) { blockEnd = j; break; }
  }
  const block = lines.slice(start + 1, blockEnd);

  const committees = [];
  const ci = block.indexOf('Committees:');
  if (ci !== -1) {
    for (let j = ci + 1; j < block.length; j++) {
      const l = block[j];
      if (/:$/.test(l) || l === 'Click to view') break;
      if (l === 'Minutes' || l.startsWith('[')) continue;      // UI noise / annotations
      const m = l.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      if (m && /chair|lead|rank|vice/i.test(m[2])) committees.push({ name: m[1].trim(), role: m[2].trim() });
      else committees.push({ name: l, role: '' });
    }
  }

  const leadership = [];
  block.forEach((l, j) => {
    if (l !== 'Leadership Position:') return;
    const v = block[j + 1];
    if (v && !/:$/.test(v) && v !== 'Click to view' && !isSessionHeader(v)) leadership.push(v);
  });

  return { committees, leadership, sessionLabel };
}

function parseRecord(html) {
  const lines = toLines(html);
  return {
    recordName: labelled(lines, 'Name Search:'),
    service: parseService(lines),
    party: labelled(lines, 'Party when first elected:'),
    counties: labelled(lines, 'Counties Served:'),
    city: labelled(lines, 'City of Residence (when first elected):'),
    occupation: labelled(lines, 'Occupation (when first elected):'),
    education: parseEducation(lines),
    govService: parseGovService(lines),
    ...parseCurrentSession(lines),
  };
}

// ── Turning a parsed record into profile content ──────────────────────────

const CHAMBER_TITLE = { house: 'State Representative', senate: 'State Senator' };

/** Merge consecutive spans in the same chamber: 2019-2022 + 2023-Present -> 2019-Present. */
function mergeService(service, chamber) {
  const want = chamber === 'house' ? 'house' : 'senate';
  const spans = service.filter(s => s.chamber.toLowerCase() === want)
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!spans.length) return null;
  return {
    start: spans[0].start,
    end: spans.some(s => s.end === 'Present') ? 'Present' : spans[spans.length - 1].end,
    districts: [...new Set(spans.map(s => s.dist))],
  };
}

function buildBio(o, rec, url) {
  const title = CHAMBER_TITLE[o.chamber];
  const other = o.chamber === 'house' ? 'senate' : 'house';
  const mine = mergeService(rec.service, o.chamber);
  const prior = mergeService(rec.service, other);
  const experience = [], sentences = [];
  // A former member's every term has an end year; a sitting member's current
  // term is open-ended. This drives tense throughout so we never write "serves"
  // about someone who has left office (Melissa Hortman, for one, is deceased).
  const serving = !o.former && !!(mine && mine.end === 'Present');

  // Current chamber service.
  if (mine) {
    const distNote = mine.districts.length > 1
      ? `Districts ${mine.districts.join(', ')} — district numbering changed under redistricting.`
      : '';
    experience.push({
      title: `${title}, District ${o.dist}`,
      org: `Minnesota ${o.chamber === 'house' ? 'House of Representatives' : 'Senate'}`,
      start: mine.start, end: mine.end, note: distNote, source: url,
    });
    // Long-serving members held several district numbers as boundaries were
    // redrawn (Melissa Hortman ran in 47B, 36B, then 34B), so name the chamber
    // and span rather than implying one district covered the whole tenure.
    const chamberName = o.chamber === 'house' ? 'House' : 'Senate';
    const where = mine.districts.length > 1
      ? `the Minnesota ${chamberName} (most recently District ${o.dist})`
      : `${chamberName} District ${o.dist}`;
    sentences.push(serving
      ? `${o.name} has represented ${where} since ${mine.start}.`
      : `${o.name} represented ${where} from ${mine.start} to ${mine.end}.`);
  }
  // Service in the other chamber, if any.
  if (prior) {
    experience.push({
      title: `${CHAMBER_TITLE[other]}, District ${prior.districts.join(', ')}`,
      org: `Minnesota ${other === 'house' ? 'House of Representatives' : 'Senate'}`,
      start: prior.start, end: prior.end, source: url,
    });
    sentences.push(`${prior.end === 'Present' ? 'They also serve' : 'They previously served'} in the Minnesota ${other === 'house' ? 'House' : 'Senate'} (${prior.start}–${prior.end}).`);
  }
  // Leadership in the current session.
  if (rec.leadership.length) {
    rec.leadership.forEach(l => experience.push({
      title: l, org: `Minnesota ${o.chamber === 'house' ? 'House of Representatives' : 'Senate'}`,
      start: '', end: '', note: rec.sessionLabel ? `Held during the ${rec.sessionLabel.replace(/\s*\(.*/, '')}.` : '',
      source: url,
    }));
    sentences.push(rec.leadership.length > 1
      ? `Leadership roles${serving ? '' : ' held'}: ${rec.leadership.join(' and ')}.`
      : `${serving ? 'Serves as' : 'Served as'} ${rec.leadership[0]}.`);
  }
  // Prior public service outside the Legislature. LRL stores these as a
  // bureaucratic category ("Municipal Council/Aldermen") plus an organisation
  // that usually carries the actual role in parentheses ("Preston, Minnesota
  // (City Mayor)"). Lead with the role and treat the place as the organisation,
  // which reads far better while keeping both facts.
  rec.govService.forEach(g => {
    const m = g.org.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    const place = (m ? m[1] : g.org).trim();
    const role = m ? m[2].trim() : '';
    // LRL writes unknown dates as literal question marks ("19?? to ?"). Showing
    // those verbatim reads like a rendering fault, so drop them and leave the
    // date blank — the role itself is still sourced.
    const [start, end] = String(g.dates || '').split(/\s+to\s+/i)
      .map(s => (s || '').trim())
      .map(s => (s.includes('?') ? '' : s));
    experience.push({
      title: role || g.category,
      org: place,
      start: start || '', end: end && end !== '?' ? end : '',
      note: [role ? g.category : '', g.how ? `${g.how} position.` : ''].filter(Boolean).join(' · '),
      source: url,
    });
  });
  if (rec.govService.length) {
    const seen = new Set(), orgs = [];
    for (const g of rec.govService) {
      const label = g.org.trim();
      if (seen.has(label)) continue;      // same body can appear for several roles
      seen.add(label); orgs.push(label);
      if (orgs.length === 3) break;
    }
    sentences.push(`Prior public service includes ${orgs.join('; ')}${seen.size < rec.govService.length ? ', among other roles' : ''}.`);
  }
  // Occupation, when it is an actual job rather than the office itself.
  if (rec.occupation && !/^state (representative|senator)$/i.test(rec.occupation.trim())) {
    experience.push({
      title: rec.occupation, org: 'Occupation when first elected', start: '', end: '', source: url,
    });
    sentences.push(`Occupation when first elected: ${rec.occupation}.`);
  }
  if (rec.city) sentences.push(`Home city of record: ${rec.city}.`);

  const headlineBits = [`${title}, District ${o.dist}`];
  if (rec.leadership.length) headlineBits.unshift(rec.leadership[0]);
  else if (rec.occupation && !/^state (representative|senator)$/i.test(rec.occupation.trim())) {
    // Some occupation fields are a full career summary ("Insurance Agency Owner,
    // President/Former High School Social Studies Teacher, and Football and
    // Wrestling Coach") — too long for a headline, so take the leading role only.
    const occ = rec.occupation.trim();
    headlineBits.push(occ.length > 48 ? occ.split(/[,/]/)[0].trim() : occ);
  }

  const bio = {
    headline: headlineBits.join(' · '),
    about: sentences.join(' '),
    aboutSource: url,
    experience,
    verified: VERIFIED,
    sources: [
      { label: 'Minnesota Legislative Reference Library — Legislators Past & Present record', url },
      o.chamber === 'house'
        ? { label: 'Minnesota House of Representatives — member roster', url: 'https://www.house.mn.gov/members/list' }
        : { label: 'Minnesota Senate — member roster', url: 'https://www.senate.mn/members' },
    ],
  };
  if (rec.education.length) bio.education = rec.education.map(e => ({ ...e, source: url }));
  if (rec.committees.length) bio.committees = rec.committees.map(c => ({ ...c, source: url }));
  return bio;
}

// ── Emit ──────────────────────────────────────────────────────────────────
const q = s => "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ') + "'";
function emit(bios) {
  const keys = Object.keys(bios).sort();
  const parts = keys.map(id => {
    const b = bios[id];
    const rows = [`    headline: ${q(b.headline)},`, `    about: ${q(b.about)},`, `    aboutSource: ${q(b.aboutSource)},`];
    rows.push('    experience: [');
    b.experience.forEach(e => rows.push(`      { title: ${q(e.title)}, org: ${q(e.org)}, start: ${q(e.start)}, end: ${q(e.end)}, note: ${q(e.note || '')}, source: ${q(e.source)} },`));
    rows.push('    ],');
    if (b.education) {
      rows.push('    education: [');
      b.education.forEach(e => rows.push(`      { school: ${q(e.school)}, degree: ${q(e.degree)}, year: ${q(e.year)}, source: ${q(e.source)} },`));
      rows.push('    ],');
    }
    if (b.committees) {
      rows.push('    committees: [');
      b.committees.forEach(c => rows.push(`      { name: ${q(c.name)}, role: ${q(c.role)}, source: ${q(c.source)} },`));
      rows.push('    ],');
    }
    rows.push('    sources: [');
    b.sources.forEach(s => rows.push(`      { label: ${q(s.label)}, url: ${q(s.url)} },`));
    rows.push('    ],');
    rows.push(`    verified: ${q(b.verified)},`);
    return `  ${q(id)}: {\n${rows.join('\n')}\n  },`;
  });
  return `const GENERATED_BIOS = {\n${parts.join('\n')}\n};`;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const appHtml = fs.readFileSync(APP, 'utf8');
  const ours = readRoster(appHtml).filter(o => o.chamber !== 'executive');
  // Statewide executives are hand-curated in MANUAL_BIOS (they are not on the
  // legislator roster); everyone else, sitting or former, is generated here.
  const lrl = await roster();
  console.log(`Tracked legislators: ${ours.length}   LRL current roster: ${lrl.size}`);

  const bios = {}, audit = {};
  const missing = [], mismatched = [], failed = [], departed = [], reconciled = [];
  const alreadyFormer = knownFormer(appHtml);

  for (const o of ours) {
    let entry;
    // Former members' seats are now held by other people, so a district lookup
    // would find the successor. Their LRL record id is pinned in the shared
    // module instead (name-search is unsafe for common surnames — there are two
    // Bruce Andersons), and the record's own name is checked below like any other.
    if (o.former && FORMER_LRL_IDS[o.id]) {
      entry = { name: o.name, chamber: o.chamber, lrlId: FORMER_LRL_IDS[o.id] };
    } else {
    entry = lrl.get(o.chamber + ':' + o.dist);
    if (!entry) {
      // Not currently seated. Fall back to a name search so we still build an
      // accurate record — their service span will correctly show an end year
      // rather than "Present" — and flag the roster discrepancy loudly.
      const id = await findDeparted(o).catch(() => null);
      if (!id) { missing.push(`${o.id} ${o.name} — no district ${o.dist} on LRL roster, and no record found by name`); continue; }
      entry = { name: o.name, chamber: o.chamber, lrlId: id };
      // Only a problem if we still present them as sitting. Once they are in the
      // app's FORMER map the two sources agree, so report it as reconciled.
      (alreadyFormer.has(o.name) ? reconciled : departed).push(
        alreadyFormer.has(o.name)
          ? `${o.id} ${o.name} (district ${o.dist}) — off the LRL roster and correctly marked former in the app.`
          : `${o.id} ${o.name} (district ${o.dist}) — NOT on the current LRL roster, but the app still lists them as sitting. Verify seat status and add them to FORMER.`);
    }
    }
    if (lastName(entry.name) !== lastName(o.name)) {
      mismatched.push(`${o.id} district ${o.dist}: app has "${o.name}", LRL roster has "${entry.name}"`);
      continue;
    }
    const url = `https://www.lrl.mn.gov/legdb/fulldetail?id=${entry.lrlId}`;
    try {
      const rec = parseRecord(await getCached(url, `member-${entry.lrlId}`));
      // Second check, against the record itself rather than the roster page.
      if (rec.recordName && recordSurname(rec.recordName) !== lastName(o.name)) {
        mismatched.push(`${o.id}: record ${entry.lrlId} is for "${rec.recordName}", expected "${o.name}"`);
        continue;
      }
      const bio = buildBio(o, rec, url);
      // A legislator's own service span is the one field that must always parse.
      // If it did not, the record format has drifted — fail loudly rather than
      // publish a profile that silently omits the office they actually hold.
      if (!rec.service.length) {
        failed.push(`${o.id} ${o.name}: could not parse "Sessions Served" from ${url} — record format may have changed`);
        continue;
      }
      bios[o.id] = bio;
      audit[o.id] = { name: o.name, district: o.dist, lrlId: entry.lrlId, url, parsed: rec };
    } catch (e) {
      failed.push(`${o.id} ${o.name}: ${e.message}`);
    }
  }

  fs.writeFileSync(AUDIT, JSON.stringify({ generated: new Date().toISOString(), audit }, null, 2));

  // Splice the generated map into the app between its markers.
  const START = '/* BIOS:GENERATED:START */', END = '/* BIOS:GENERATED:END */';
  const a = appHtml.indexOf(START), b = appHtml.indexOf(END);
  if (a === -1 || b === -1) throw new Error('BIOS:GENERATED markers not found in public/index.html');
  fs.writeFileSync(APP, appHtml.slice(0, a + START.length) + '\n' + emit(bios) + '\n' + appHtml.slice(b));

  const withEdu = Object.values(bios).filter(b => b.education).length;
  const withCom = Object.values(bios).filter(b => b.committees).length;
  const withPrior = Object.values(bios).filter(b => b.experience.some(e => e.org === 'Occupation when first elected' || /Board|Council|Agency|Commission|Mayor|County|School/i.test(e.title))).length;
  console.log(`\nGenerated ${Object.keys(bios).length} biographies`);
  console.log(`  with education: ${withEdu}   with committees: ${withCom}   with prior public service/occupation: ${withPrior}`);
  console.log(`  audit written to ${path.relative(ROOT, AUDIT)}`);
  const report = (label, arr) => { if (arr.length) console.log(`\n${label} (${arr.length}):\n  ` + arr.join('\n  ')); };
  report('⚠ ROSTER DISCREPANCY — still shown as sitting, but off the current LRL roster', departed);
  report('Left office — already reconciled as former members', reconciled);
  report('No LRL roster entry', missing);
  report('SKIPPED — name mismatch', mismatched);
  report('Failed', failed);
}

main().catch(e => { console.error(e); process.exit(1); });
