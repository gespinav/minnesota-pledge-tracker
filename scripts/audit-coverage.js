#!/usr/bin/env node
/**
 * audit-coverage.js — does every official actually have a portrait and a bio?
 *
 * Walks the app's real seed data (all 210 records, including former members —
 * they have profile pages too) and checks each one for:
 *   • a portrait file on disk at public/photos/<id>.webp
 *   • a biography, and which sections of it are populated
 *
 * "Full bio" is defined as the three sections every profile should carry:
 * an About narrative, a public-service timeline, and a source list. Education
 * and committees are reported separately because a number of officials
 * genuinely have those sections empty in the source record — absent there is
 * correct, not a gap.
 *
 * Usage:  node scripts/audit-coverage.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'public', 'index.html');
const PHOTOS = path.join(ROOT, 'public', 'photos');

const src = fs.readFileSync(APP, 'utf8');
const scripts = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = scripts.sort((a, b) => b.length - a.length)[0];

/** Evaluate buildSeed() and the bio maps in isolation, without touching the DOM. */
function loadData() {
  const seed = main.slice(main.indexOf('function buildSeed()'), main.indexOf('const STATE = { officials: buildSeed()'));
  const gStart = src.indexOf('/* BIOS:GENERATED:START */') + '/* BIOS:GENERATED:START */'.length;
  const gEnd = src.indexOf('/* BIOS:GENERATED:END */');
  const generated = src.slice(gStart, gEnd);
  const mStart = src.indexOf('const MANUAL_BIOS = {');
  const mEnd = src.indexOf('const OFFICIAL_BIOS = Object.assign');
  const manual = src.slice(mStart, mEnd);
  const lrl = "const LRL = 'https://www.lrl.mn.gov/legdb/fulldetail?id=';\n";
  return new Function(
    lrl + seed + generated + manual +
    'return { officials: buildSeed(), bios: Object.assign({}, GENERATED_BIOS, MANUAL_BIOS) };'
  )();
}

const { officials, bios } = loadData();

const rows = officials.map(o => {
  const bio = bios[o.id];
  const photo = fs.existsSync(path.join(PHOTOS, `${o.id}.webp`));
  return {
    id: o.id,
    name: o.name,
    chamber: o.chamber,
    former: !!o.former,
    photo,
    bio: !!bio,
    about: !!(bio && bio.about && bio.about.trim()),
    experience: !!(bio && bio.experience && bio.experience.length),
    sources: !!(bio && bio.sources && bio.sources.length),
    education: !!(bio && bio.education && bio.education.length),
    committees: !!(bio && bio.committees && bio.committees.length),
    tense: tenseMismatch(o, bio),
  };
});

/**
 * Cross-check the biography against the app's own view of who is serving.
 * A sitting member must have an open-ended term somewhere in their timeline;
 * a former member must not. This catches a class of error the source-verifier
 * cannot see — a truncated career reads as perfectly valid text, every word of
 * it present in the source, while quietly retiring someone who still holds
 * office. That is exactly how Tim O'Driscoll's service came to stop at 2022.
 */
function tenseMismatch(o, bio) {
  if (!bio || !bio.experience) return null;
  const office = bio.experience.filter(e => /^(State Representative|State Senator|Governor|Lieutenant Governor|Attorney General|Secretary of State),?/.test(e.title));
  if (!office.length) return null;
  const open = office.some(e => e.end === 'Present');
  if (!o.former && !open) return 'serving, but no current term in the timeline';
  if (o.former && open) return 'marked former, but the timeline still shows a current term';
  return null;
}

const full = r => r.about && r.experience && r.sources;
const pct = (n, d) => `${n}/${d} (${Math.round((n / d) * 100)}%)`;

const noPhoto = rows.filter(r => !r.photo);
const noBio = rows.filter(r => !r.bio);
const partialBio = rows.filter(r => r.bio && !full(r));
const complete = rows.filter(r => r.photo && full(r));

console.log(`Officials in app        : ${rows.length}  (${rows.filter(r => !r.former).length} serving, ${rows.filter(r => r.former).length} former)`);
console.log(`Has portrait            : ${pct(rows.length - noPhoto.length, rows.length)}`);
console.log(`Has a bio               : ${pct(rows.length - noBio.length, rows.length)}`);
console.log(`Has a FULL bio          : ${pct(rows.filter(full).length, rows.length)}   (about + timeline + sources)`);
console.log(`Portrait AND full bio   : ${pct(complete.length, rows.length)}`);
console.log(`  ├─ with education     : ${pct(rows.filter(r => r.education).length, rows.length)}`);
console.log(`  └─ with committees    : ${pct(rows.filter(r => r.committees).length, rows.length)}`);

const show = (label, list, extra = () => '') => {
  if (!list.length) return;
  console.log(`\n${label} (${list.length}):`);
  list.forEach(r => console.log(`  ${r.id.padEnd(12)} ${r.name.padEnd(26)} ${r.former ? '[former] ' : ''}${r.chamber}${extra(r)}`));
};

show('MISSING PORTRAIT', noPhoto);
show('MISSING BIO ENTIRELY', noBio);
show('PARTIAL BIO', partialBio, r =>
  '  missing: ' + ['about', 'experience', 'sources'].filter(k => !r[k]).join(', '));

const tenseBad = rows.filter(r => r.tense);
show('TIMELINE CONTRADICTS SERVING STATUS', tenseBad, r => '  — ' + r.tense);

const gaps = noPhoto.length + noBio.length + partialBio.length + tenseBad.length;
console.log(gaps
  ? `\n${gaps} record${gaps === 1 ? '' : 's'} still incomplete.`
  : '\n✓ Every official has a portrait and a full bio.');
