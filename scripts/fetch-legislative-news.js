#!/usr/bin/env node
/**
 * fetch-legislative-news.js — build the "Upcoming Bills" news bulletin.
 *
 * WHY THIS RUNS AT BUILD TIME, NOT IN THE BROWSER
 * The app is a static, keyless page with a strict CSP (connect-src 'self').
 * A browser cannot call news APIs directly: the CSP blocks the hosts, most news
 * APIs forbid cross-origin (CORS) browser calls, and any API key placed in
 * client code would be exposed to everyone. So the "API tapping" happens here,
 * server-side, and the result is written as a same-origin JSON file the static
 * page simply reads. No key is ever shipped to the browser.
 *
 * SOURCE
 * Google News RSS — keyless, no account, returns real, dated, attributed items
 * with links back to the original publishers. We never invent or summarise
 * bills; every card links to a real article.
 *
 * TRUSTED SOURCES ONLY
 * Results are filtered to an allowlist (ALLOWED_SOURCES below): Minnesota
 * government/official sources — including the legislative caucuses — plus
 * established Minnesota news organizations (Star Tribune, Pioneer Press, MPR,
 * MN PBS, Fox 9, KARE 11, WCCO/CBS Minnesota, KSTP, MinnPost, Minnesota
 * Reformer, Sahan Journal, regional MN outlets, …). National/out-of-state
 * outlets and advocacy/trade groups are dropped. A per-source cap keeps the
 * bulletin diverse.
 *
 * A keyed, *structured* legislative source (e.g. OpenStates, LegiScan) could be
 * added later for true bill-status/upcoming-vote data — drop its key in an env
 * var and extend fetchStructured() below. Until then this is a news bulletin,
 * honestly labelled as such in the UI.
 *
 * Refresh:  node scripts/fetch-legislative-news.js
 * (Best wired to a scheduled GitHub Action so the bulletin stays current.)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const OUT = path.join(OUT_DIR, 'upcoming-bills.json');
const MAX_ITEMS = 30;

// Focused queries that surface bills moving through the Legislature. During
// session these catch committee action and floor votes; between sessions they
// catch enacted-law follow-ups and interim news.
const QUERIES = [
  'Minnesota legislature bill',
  'Minnesota bill vote OR committee OR signed',
  'Minnesota legislature session',
];

// TRUSTED SOURCES ONLY. An item is kept only if its source name (as labelled by
// Google News) matches one of these — Minnesota government/official sources
// (including the legislative caucuses), plus established Minnesota news
// organizations. Everything else is dropped: national/out-of-state outlets and
// advocacy/trade groups. Matched case-insensitively as a substring, so 'fox 9'
// catches "FOX 9 Minneapolis-St. Paul" and '.gov' catches "… (.gov)" sources.
// Edit this list to add or remove a source.
const ALLOWED_SOURCES = [
  // Minnesota government / official (nonpartisan)
  '.gov', 'session daily',
  // Official legislative caucus communications (partisan, but primary sources
  // from the elected bodies themselves).
  'senate dfl', 'senate republican', 'house dfl', 'house republican',
  // Established Minnesota news organizations
  'star tribune', 'startribune',
  'pioneer press',
  'mpr news', 'minnesota public radio',
  'minnpost',
  'minnesota reformer',
  'sahan journal',
  'fox 9', 'kmsp',
  'kare 11', 'kare11',
  'kstp', '5 eyewitness',
  'wcco', 'cbs minnesota', 'cbs news',      // WCCO / CBS Minnesota
  'twin cities pbs', 'pbs minnesota', 'pioneer pbs', 'lakeland pbs', 'tpt',
  'duluth news tribune', 'northern news now',
  'post bulletin', 'kttc', 'kaaltv',        // Rochester / SE Minnesota
  'mankato free press',
  'st. cloud times', 'knsi',                // St. Cloud
  'axios twin cities', 'axios',
];
// No more than this many items from any single source, so one prolific source
// (e.g. the House .gov "Legislative Update" pages) can't crowd out the rest.
const PER_SOURCE_CAP = 5;
const isAllowed = src => { const s = String(src || '').toLowerCase(); return ALLOWED_SOURCES.some(a => s.includes(a)); };

const decode = s => String(s)
  .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, ' ').trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};

async function fetchQuery(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (news bulletin build)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for query "${q}"`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  return items.map(block => {
    const title = decode(tag(block, 'title'));
    // Title arrives as "Headline - Publisher"; split the trailing source off.
    const src = decode(tag(block, 'source')) || (title.includes(' - ') ? title.split(' - ').pop() : '');
    const cleanTitle = src && title.endsWith(' - ' + src) ? title.slice(0, -(src.length + 3)) : title;
    const pub = tag(block, 'pubDate').trim();
    const d = pub ? new Date(pub) : null;
    return {
      title: cleanTitle,
      source: src,
      url: (tag(block, 'link') || '').trim(),
      date: d && !isNaN(d) ? d.toISOString().slice(0, 10) : '',
      ts: d && !isNaN(d) ? d.getTime() : 0,
    };
  }).filter(it => it.title && it.url);
}

async function main() {
  const seen = new Set(), all = [];
  const dropped = {};   // source -> count, for reporting what was filtered out
  for (const q of QUERIES) {
    try {
      const items = await fetchQuery(q);
      let kept = 0;
      for (const it of items) {
        const key = it.title.toLowerCase().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        // Trusted sources only.
        if (!isAllowed(it.source)) { dropped[it.source] = (dropped[it.source] || 0) + 1; continue; }
        all.push(it); kept++;
      }
      console.log(`  "${q}" → ${items.length} fetched, ${kept} from trusted sources`);
    } catch (e) {
      console.warn(`  "${q}" failed: ${e.message}`);
    }
  }

  all.sort((a, b) => b.ts - a.ts);

  // Diversity cap: at most PER_SOURCE_CAP items per source, newest first, so no
  // single source dominates the bulletin.
  const perSource = {}, capped = [];
  for (const it of all) {
    const s = it.source || '';
    perSource[s] = (perSource[s] || 0) + 1;
    if (perSource[s] <= PER_SOURCE_CAP) capped.push(it);
  }
  const items = capped.slice(0, MAX_ITEMS).map(({ ts, ...rest }) => rest);

  const droppedList = Object.entries(dropped).sort((a, b) => b[1] - a[1]);
  if (droppedList.length) {
    console.log(`\nExcluded (untrusted) sources: ` +
      droppedList.slice(0, 12).map(([s, n]) => `${s} (${n})`).join(', ') +
      (droppedList.length > 12 ? `, +${droppedList.length - 12} more` : ''));
  }
  const bySource = {}; items.forEach(i => { bySource[i.source] = (bySource[i.source] || 0) + 1; });
  console.log(`Kept ${items.length} items from ${Object.keys(bySource).length} trusted sources.`);

  // Idempotence: if the headlines are unchanged since last run, leave the file
  // exactly as-is (timestamp included). The scheduled refresh then produces no
  // git change and no needless commit/deploy — "generated" only advances when
  // there is genuinely new news.
  // Identity = the SET of headlines, order-independent. Google News rotates and
  // reorders items and mints fresh redirect URLs per request, so comparing by
  // sorted titles is the stable "did the news actually change" signal.
  const signature = arr => JSON.stringify((arr || []).map(i => i.title).sort());
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (signature(prev.items) === signature(items)) {
      console.log(`\nNo change in bulletin items (${items.length}); existing file left untouched.`);
      return;
    }
  } catch (e) { /* no existing file — write a fresh one below */ }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Google News RSS — Minnesota Legislature queries (trusted MN sources only)',
    note: 'A legislative news bulletin, limited to Minnesota government/official sources and '
        + 'established Minnesota news organizations. Every item links to the original publisher; '
        + 'the app aggregates headlines, it does not author or fabricate bill content. '
        + 'For authoritative bill status and upcoming votes, use the official trackers linked in the app.',
    items,
  }, null, 2));

  console.log(`\nWrote ${items.length} items → ${path.relative(ROOT, OUT)}`);
  if (items[0]) console.log(`Most recent: ${items[0].date}  ${items[0].title.slice(0, 70)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
