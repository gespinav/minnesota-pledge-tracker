# Minnesota Pledge Tracker

A civic-accountability web app that scores Minnesota's elected officials on **campaign promises kept vs. broken** and tracks their **landmark roll-call votes** — all sourced from primary MN government records (House & Senate Journals, revisor.mn.gov).

**▶ Live site:** https://gespinav.github.io/minnesota-pledge-tracker/

## What it does

- **All 210 officials** (206 current + 4 former): 5 executives, 67 senators, 134 representatives.
- **Letter grades** based on individually-sourced campaign promises (kept / partial / broken). Vote-alignment is shown as a *separate* context metric, so party-line vote loyalty doesn't inflate the grade.
- **Bills & Votes dashboards** — 38 tracked bills with plain-language explainers, party-by-party vote breakdowns, and who voted yes/no, each verified member-by-member against the official journals.
- **Per-topic browsing** and a **"My Interests"** profile for saving the bills you care about (optionally synced across devices via Firebase cloud auth).
- **⚑ Watch flags** for officials with pending status changes (e.g., a governor run or retirement).
- **Per-official profile pages** with the member's official portrait, a sourced public-service timeline, education, committees, promises, votes and a citation list — each at its own shareable URL.
- **Mobile-ready**: a slide-in nav drawer, a permanent Home button on every page, and layouts that adapt down to phone widths.

## Project layout

| Path | What it is |
|------|-----------|
| `public/index.html` | The entire standalone web app (HTML/CSS/JS inline). This is what GitHub Pages serves. |
| `public/photos/` | Official member portraits (WebP, ~19 KB each) + `manifest.json` recording each one's source URL. |
| `scripts/fetch-photos.js` | Re-runnable fetcher for those portraits. See "Refreshing portraits" below. |
| `data/officials.js` | Auto-generated mirror of the app's `buildSeed()` data, consumed by the API. |
| `api/server.js`, `api/db.js` | Optional Express + SQLite server for persistence and an admin write API (not needed for the live site). |
| `START_HERE.md` | Project notes. |

## URLs / routing

Every view has a hash route, so pages and individual officials are shareable and the browser (and phone) Back button works:

| Route | View |
|-------|------|
| `#/home`, `#/officials`, `#/bills`, `#/leaderboard`, `#/profile`, `#/admin`, `#/progress`, `#/methodology` | Main pages |
| `#/official/<id>` | An official's profile — e.g. `#/official/sen-64`, `#/official/rep-13A`, `#/official/exec-gov` |

## Refreshing portraits

Portraits come from each member's own chamber — House from `house.mn.gov/hinfo/memberimgls94/<district>.gif`, Senate from `senate.mn/graphics/<file>.jpg` (filenames via `senate.mn/api/members`). The originals are 200–500 KB each, so the script resizes them to 400px WebP.

```bash
npm install --no-save sharp
node scripts/fetch-photos.js
```

Portraits are keyed by **district**, and districts get reassigned at every election — so the script checks the roster's name for each district against the name in `buildSeed()` and **skips (and reports) any mismatch** rather than risk showing the wrong person's face. Re-run it after each election and review any skips.

The five statewide executives aren't on either chamber roster and their offices' sites block scripted fetches; add direct image URLs to the `EXEC_PHOTOS` map in the script to include them. Until then they fall back to initials avatars.

## Official biographies

Biographical content lives in the `OFFICIAL_BIOS` map in `public/index.html` and is **source-gated**: every claim carries the URL it came from, and officials with no researched bio render an explicit "not yet researched" state rather than placeholder prose. The primary source is the Legislature's own [Legislators Past & Present](https://www.lrl.mn.gov/legdb/) database.

Currently populated: Tim Walz (limited), Peggy Flanagan, Erin Murphy, Mark Johnson, Lisa Demuth. Set `verified` to the date a human last checked an entry.

The web app is **fully client-side** — the live site needs no server. The API is only for optional persistence when self-hosting.

## Run locally

```bash
npm install
npm start        # serves the app + API at http://localhost:8787
```

Or just open `public/index.html` directly in a browser.

## Optional: cloud user profiles (Firebase)

Cross-device sign-in and saved-bill sync are built in but **off by default** — the app runs local-only until a Firebase config is provided. See the `FIREBASE SETUP` block near the bottom of `public/index.html` for the one-time (free) setup: create a Firebase project, paste the web config, enable Email/Password + Google auth, create Firestore, and publish the included security rule. Firebase web-config values are public by design; access is enforced by Firestore rules + App Check.

## Security

- No secrets are committed. The admin write API is gated by an `ADMIN_TOKEN` **environment variable**; set it (plus `ALLOWED_ORIGINS`) and run behind HTTPS before deploying the server.
- Content-Security-Policy, CORS restriction, rate limiting, and HTML-escaping are in place.

## Data & methodology

Every promise and vote cites a primary source. Grades follow the scale on the app's **Methodology** page. Vote records are parsed from MN House journals (`house.mn.gov/cco/journals/`) and Senate journals (`senate.mn/journals/`).
