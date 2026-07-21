/**
 * roster.js — read the app's own list of officials out of public/index.html.
 *
 * Shared by fetch-photos.js and fetch-bios.js. It lives here because both
 * scripts previously carried their own copy of this parsing, and a bug in it
 * silently dropped a legislator from both pipelines at once:
 *
 *   ['13A','Lisa Demuth','R'],['13B',"Tim O'Driscoll",'R'],
 *
 * Every seed entry is single-quoted except the handful whose names contain an
 * apostrophe, which are double-quoted instead. A regex that assumed single
 * quotes matched 133 of 134 representatives and reported success, so Tim
 * O'Driscoll ended up with neither a portrait nor a biography and nothing
 * flagged it.
 *
 * Two defences against a repeat:
 *   1. names are matched in either quoting style
 *   2. the entry count is checked against a quote-agnostic count of district
 *      markers, and a mismatch throws rather than quietly returning a short list
 */

/** Matches 'text' or "text", capturing the contents of whichever was used. */
const QUOTED = `(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`;
const unescape = s => String(s).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');

function block(html, name) {
  const m = html.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`could not locate ${name} in public/index.html`);
  return m[1];
}

/**
 * Legislative Reference Library record ids for the app's former members.
 *
 * These are pinned rather than looked up by name, because name search is not
 * safe for them. Searching "Anderson" returns two Bruce Andersons — Bruce W.
 * "Buzz" Anderson (House 1977-84) and Bruce Douglas Anderson (House 1995-2012,
 * Senate 2013-2025, District 29). Only the latter is ours, and an automated
 * match would happily have picked the wrong one and published his career under
 * the other man's name. Each id below was confirmed against the record's own
 * name and service history.
 *
 * Verified 2026-07-20.
 */
const FORMER_LRL_IDS = {
  'former-hortman':   '12266',  // Hortman, Melissa — House 2005-2012 (47B), 2013-2022 (36B), 2023-2025 (34B)
  'former-banderson': '10013',  // Anderson, Bruce Douglas — House 1995-2012, Senate 2013-2025 (29)
  'former-nmitchell': '15586',  // Mitchell, Nicole — Senate 2023-2025 (47)
  'former-kvher':     '15532',  // Her, Kaohly Vang — House 2019-2022 (64A), 2023-2025 (64A)
};

/**
 * @returns {Array<{id,chamber,dist,name,office?,former?}>} every official the
 *          app tracks, including the hand-written formerMembers entries — they
 *          have profile pages too, so they need portraits and biographies.
 */
function readRoster(html) {
  const out = [];

  // Statewide executives: { id:'exec-gov', chamber:'executive', office:'Governor', name:'Tim Walz', … }
  for (const m of html.matchAll(
    new RegExp(`\\{id:'(exec-[a-z]+)',chamber:'executive',office:${QUOTED},name:${QUOTED}`, 'g'))) {
    out.push({ id: m[1], chamber: 'executive', dist: null, office: unescape(m[2] ?? m[3]), name: unescape(m[4] ?? m[5]) });
  }

  // Senate: [64,'Erin Murphy','DFL','Saint Paul',2020,'Majority Leader']
  const sen = block(html, 'senDists');
  for (const m of sen.matchAll(new RegExp(`\\[(\\d+),\\s*${QUOTED}\\s*,`, 'g'))) {
    out.push({ id: `sen-${m[1]}`, chamber: 'senate', dist: m[1], name: unescape(m[2] ?? m[3]) });
  }
  const senExpected = [...sen.matchAll(/\[(\d+)\s*,/g)].length;
  const senGot = out.filter(o => o.chamber === 'senate').length;
  if (senGot !== senExpected)
    throw new Error(`senDists: parsed ${senGot} of ${senExpected} senators — a name is quoted in an unexpected way`);

  // House: ['45B','Patty Acomb','DFL']
  const hou = block(html, 'houseRaw');
  for (const m of hou.matchAll(new RegExp(`\\['(\\d+[AB])'\\s*,\\s*${QUOTED}\\s*,`, 'g'))) {
    out.push({ id: `rep-${m[1]}`, chamber: 'house', dist: m[1], name: unescape(m[2] ?? m[3]) });
  }
  const houExpected = [...hou.matchAll(/\[\s*['"](\d+[AB])['"]\s*,/g)].length;
  const houGot = out.filter(o => o.chamber === 'house').length;
  if (houGot !== houExpected)
    throw new Error(`houseRaw: parsed ${houGot} of ${houExpected} representatives — a name is quoted in an unexpected way`);

  // Former members: full objects rather than tuples, each carrying its own id.
  // { id:'former-hortman', chamber:'house', dist:'34B', name:'Melissa Hortman', … }
  for (const m of html.matchAll(
    new RegExp(`\\{id:'(former-[a-z]+)',chamber:'(house|senate)',dist:'([^']*)',name:${QUOTED}`, 'g'))) {
    out.push({ id: m[1], chamber: m[2], dist: m[3], name: unescape(m[4] ?? m[5]), former: true });
  }
  const formerExpected = (html.match(/\{id:'former-[a-z]+',/g) || []).length;
  const formerGot = out.filter(o => o.former).length;
  if (formerGot !== formerExpected)
    throw new Error(`formerMembers: parsed ${formerGot} of ${formerExpected} entries — an entry is shaped unexpectedly`);

  return out;
}

module.exports = { readRoster, FORMER_LRL_IDS };
