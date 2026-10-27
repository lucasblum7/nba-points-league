# NBA Points League 2026–27

Standings, rosters and nightly scores for our six-person NBA points league.

- **Site:** `index.html`, `style.css`, `app.js` (plain HTML/JS, no build step), served by GitHub Pages.
- **Data:** `data/*.json`. `scripts/update.py` rebuilds results, betting lines, today's slate and playoff/Cup bonuses from ESPN's public scoreboard.
- **Schedule:** `.github/workflows/update.yml` runs the update every 15 minutes from 9 AM to 1 AM Pacific and commits any changes. Run it by hand from the **Actions** tab ("Update scores" → "Run workflow").

## Editing the league
- Rosters: `data/rosters.json`
- Scoring values and upset tiers: `data/config.json`
- Preseason projections: `data/projections.json`
