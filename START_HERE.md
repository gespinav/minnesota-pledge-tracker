# MN Pledge Tracker — START HERE

You have unzipped a folder called `mn-scorecard`. This folder contains everything needed to run the tracker.

## Folder contents

```
mn-scorecard/
├── package.json         ← Tells npm what to install (DO NOT EDIT)
├── api/
│   └── server.js        ← The Express API server
├── data/
│   └── officials.js     ← All 206 MN officials with verified data
├── public/
│   └── index.html       ← The web app (works standalone OR through API)
└── START_HERE.md        ← This file
```

---

## Three-command quick start

Open a terminal, then:

```
cd /path/to/mn-scorecard
npm install
npm start
```

When you see `🏛️ MN Pledge Tracker API listening on http://localhost:3001`, open that URL in your browser. Done.

---

## Detailed instructions (if the quick start failed)

### Common problem: "Missing script: start"

This means you ran `npm start` from the **wrong folder**. You must be inside the `mn-scorecard` folder before running any `npm` command.

To check where you are:

```
pwd
```

To check if you're in the right place, run:

```
ls
```

You should see `package.json`, `api`, `data`, `public` listed. If you don't, you're in the wrong folder.

### How to navigate to the folder

If you unzipped to your home directory, the path is most likely:

**Linux / Chromebook Linux container:**
```
cd ~/mn-scorecard
```

**Mac:**
```
cd ~/Downloads/mn-scorecard
```
(or wherever you extracted it)

**Windows:**
```
cd C:\Users\YOURNAME\Downloads\mn-scorecard
```

If unsure where it ended up, search for it:

```
find ~ -name "mn-scorecard" -type d 2>/dev/null
```

The output is the full path. `cd` into it.

### Step-by-step from the beginning

1. Open a terminal (Linux: any terminal app · Mac: Terminal · Windows: Command Prompt or PowerShell).

2. Navigate into the project folder:
   ```
   cd ~/mn-scorecard
   ```
   (Adjust the path if you unzipped somewhere else.)

3. Confirm you're in the right place:
   ```
   ls
   ```
   You must see `package.json` in the output. If not, you're not in the right folder.

4. Confirm `package.json` has the start script:
   ```
   cat package.json
   ```
   You should see a line `"start": "node api/server.js"` inside the `"scripts"` block.

5. Install dependencies (first time only):
   ```
   npm install
   ```
   Wait for "added X packages" and "found 0 vulnerabilities."

6. Start the server:
   ```
   npm start
   ```
   You should see:
   ```
   > mn-officials-scorecard@1.0.0 start
   > node api/server.js

   🏛️  MN Pledge Tracker API listening on http://localhost:3001
   ```

7. Open your browser to: `http://localhost:3001`

---

## Two ways to use the app

### Way 1: Through the API server (recommended)

- Run `npm start` to launch the server.
- Open `http://localhost:3001` in your browser.
- The web app loads with all 206 officials.
- The Admin panel saves data to the server's memory.
- Data persists as long as the server is running.
- Stop the server with **Ctrl+C** in the terminal.

**Limitation:** Stopping the server clears in-memory data. To persist across restarts, see the SQLite section in `SETUP_PART_2_DETAILED.md`.

### Way 2: Standalone (no server needed)

- Just double-click `public/index.html`.
- Browser opens the app.
- All 206 officials are loaded from the file's built-in seed data.
- Admin panel changes are kept in browser memory only — refreshing the page wipes them.
- Use the Export button (top-right of All Officials page) to copy your work as JSON before closing.

---

## API endpoints (when server is running)

If you want to programmatically interact with the data:

- `GET  http://localhost:3001/api/officials` — list all 206 officials
- `GET  http://localhost:3001/api/officials/:id` — single official with promises and votes
- `POST http://localhost:3001/api/officials/:id/promises` — add a promise
- `POST http://localhost:3001/api/officials/:id/votes` — add a vote
- `POST http://localhost:3001/api/votes/bulk-import` — bulk roll call import
- `GET  http://localhost:3001/api/leaderboard` — ranked scoreboard
- `GET  http://localhost:3001/api/stats` — summary statistics
- `GET  http://localhost:3001/api/export` — full JSON dump

---

## Stopping and restarting

- **Stop the server:** click in the terminal window, press **Ctrl+C** (works on all platforms).
- **Restart:** run `npm start` again from the same folder.
- **Close everything:** Ctrl+C, then close the terminal window.

---

## Adding more officials' data

The seed data ships with 17 officials individually populated with promises (5 executives + 12 leadership legislators). All 201 legislators have 5 landmark votes each (HF1, HF7, HF5, HF100, HF1-2025-SS) via party-line inference.

To add more:
- Use the in-app Admin panel for one-at-a-time entry.
- For bulk roll-call imports, paste JSON into the Bulk Import panel.
- For automated research at scale, see `claude_code_research_command.md` (sent separately).

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `npm: command not found` | Node.js isn't installed. Get it from https://nodejs.org (LTS version). |
| `Missing script: "start"` | You're in the wrong folder. Run `ls` — if you don't see `package.json`, `cd` to the right folder. |
| `Port 3001 already in use` | Another server is running on port 3001. Stop it, or edit `api/server.js` to use a different port. |
| `Cannot find module 'express'` | You skipped `npm install`. Run it. |
| Browser shows "site can't be reached" | Confirm the terminal still shows the "listening" message. If not, the server crashed — check the error in the terminal. |
| Page loads but no officials show | Hard-refresh the browser (Ctrl+Shift+R or Cmd+Shift+R) to bypass cache. |

---

## What's working out of the box

- ✅ All 206 MN officials with verified contact info
- ✅ 17 officials fully scored (5 executives + 12 legislative leaders)
- ✅ 83+ sourced campaign promises
- ✅ 1,050+ vote records (37 individual + 1,005 party-line bulk)
- ✅ Admin panel for adding more
- ✅ Bulk roll-call import for spreadsheet pastes
- ✅ Public read-only API at /api/*
- ✅ Scorecard rankings
- ✅ JSON export

## What requires more work (not blocking, see other docs)

- Promise data for 189 remaining legislators
- Member-by-member roll-call extraction for 5 R cross-overs on HF100
- 2026 session vote tracking (ongoing)
- SQLite persistence layer (instructions in `SETUP_PART_2_DETAILED.md`)
