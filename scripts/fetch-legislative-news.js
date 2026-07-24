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
 * with links back to the original publishers (including official .gov sources).
 * We never invent or summarise bills; every card links to a real article.
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
  for (const q of QUERIES) {
    try {
      const items = await fetchQuery(q);
      for (const it of items) {
        const key = it.title.toLowerCase().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key); all.push(it);
      }
      console.log(`  "${q}" → ${items.length} items`);
    } catch (e) {
      console.warn(`  "${q}" failed: ${e.message}`);
    }
  }

  all.sort((a, b) => b.ts - a.ts);
  const items = all.slice(0, MAX_ITEMS).map(({ ts, ...rest }) => rest);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Google News RSS — Minnesota Legislature queries',
    note: 'A legislative news bulletin. Every item links to the original publisher; '
        + 'the app aggregates headlines, it does not author or fabricate bill content. '
        + 'For authoritative bill status and upcoming votes, use the official trackers linked in the app.',
    items,
  }, null, 2));

  console.log(`\nWrote ${items.length} items → ${path.relative(ROOT, OUT)}`);
  if (items[0]) console.log(`Most recent: ${items[0].date}  ${items[0].title.slice(0, 70)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
