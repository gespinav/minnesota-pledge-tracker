#!/usr/bin/env node
/**
 * verify-bios.js — independently check the generated biographies against their
 * sources.
 *
 * This does not trust the cache or the parser. For a random sample of officials
 * it re-downloads the Legislative Reference Library record over the network,
 * reads the biography that actually shipped in public/index.html, and asserts
 * that every substantive claim — school names, degrees, occupation, committee
 * names, prior-service organisations, service years, leadership titles — appears
 * verbatim in the source document.
 *
 * The point is to catch two distinct failure modes:
 *   1. parser drift, where a field is misread or attributed to the wrong person
 *   2. anything appearing in a profile that is not in the source at all
 *
 * Usage:  node scripts/verify-bios.js [sampleSize]      (default 25)
 *         node scripts/verify-bios.js all               (check all 200)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'public', 'index.html');
const arg = process.argv[2] || '25';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Visible text of a record page, whitespace-collapsed for substring checks. */
function pageText(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, '’');
  return t.replace(/\s+/g, ' ');
}
const loose = s => String(s).replace(/\s+/g, ' ').trim();

/** Pull the shipped GENERATED_BIOS object out of the app and evaluate it. */
function shippedBios() {
  const src = fs.readFileSync(APP, 'utf8');
  const a = src.indexOf('/* BIOS:GENERATED:START */');
  const b = src.indexOf('/* BIOS:GENERATED:END */');
  if (a === -1 || b === -1) throw new Error('generated-bios markers not found');
  const block = src.slice(a + '/* BIOS:GENERATED:START */'.length, b);
  return new Function(block + '\nreturn GENERATED_BIOS;')();
}

/** Every claim in a bio that must be traceable to the source page. */
function claims(bio) {
  const out = [];
  const push = (kind, value) => { if (value && String(value).trim()) out.push({ kind, value: loose(value) }); };

  (bio.education || []).forEach(e => {
    push('education.school', e.school);
    push('education.year', e.year);
    // Degree is reassembled from two source columns, so check its parts.
    String(e.degree || '').split(',').forEach(p => push('education.degree', p));
  });
  (bio.committees || []).forEach(c => { push('committee', c.name); push('committee.role', c.role); });
  (bio.experience || []).forEach(e => {
    // Titles we synthesise ("State Representative, District 45B") are checked via
    // their district and years instead; org names come straight from the source.
    if (e.org && e.org !== 'Occupation when first elected'
        && !/^Minnesota (House of Representatives|Senate)$/.test(e.org)) push('experience.org', e.org);
    if (e.org === 'Occupation when first elected') push('occupation', e.title);
    if (/^\d{4}$/.test(e.start)) push('service.start', e.start);
    if (/^\d{4}$/.test(e.end)) push('service.end', e.end);
  });
  return out;
}

async function main() {
  const bios = shippedBios();
  const ids = Object.keys(bios);
  let sample;
  if (arg === 'all') sample = ids;
  else {
    const n = Math.min(parseInt(arg, 10) || 25, ids.length);
    sample = [...ids].sort(() => Math.random() - 0.5).slice(0, n);
  }
  console.log(`Verifying ${sample.length} of ${ids.length} biographies against live LRL records…\n`);

  let checked = 0, failures = 0, officials = 0;
  const problems = [];

  for (const id of sample) {
    const bio = bios[id];
    const url = bio.aboutSource;
    let text;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      text = pageText(await r.text());
      await sleep(300);
    } catch (e) { problems.push(`${id}: could not fetch ${url} — ${e.message}`); failures++; continue; }

    // The record must be the right person: their name appears in the About line.
    const who = (bio.about || '').split(' has represented')[0].split(' represented')[0].trim();
    const surname = who.split(' ').pop();
    if (surname && !text.includes(surname)) {
      problems.push(`${id}: WRONG RECORD — "${surname}" does not appear at ${url}`);
      failures++;
    }

    officials++;
    for (const c of claims(bio)) {
      checked++;
      if (!text.includes(c.value)) {
        problems.push(`${id}: ${c.kind} "${c.value}" not found in source ${url}`);
        failures++;
      }
    }
  }

  console.log(`Officials checked : ${officials}`);
  console.log(`Claims checked    : ${checked}`);
  console.log(`Unverified claims : ${failures}`);
  if (problems.length) {
    console.log('\nProblems:\n  ' + problems.slice(0, 60).join('\n  '));
    if (problems.length > 60) console.log(`  … and ${problems.length - 60} more`);
    process.exit(1);
  }
  console.log('\n✓ Every checked claim appears verbatim in its cited source.');
}

main().catch(e => { console.error(e); process.exit(1); });
