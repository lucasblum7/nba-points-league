#!/usr/bin/env python3
"""Playoff odds for every NBA team, written to data/odds.json.

How it works (all standard library):

1. Team strength. Each team gets a rating in points per game versus an average
   team. It is a weighted fit of three things:
     - the preseason win total (where every team starts),
     - actual results so far: point margins, adjusted for the opponent and home
       court, with recent games counting more (momentum),
     - betting spreads, which carry the market's view of injuries, rest and
       everything else.
   Early in the season the preseason line dominates; the more games are played,
   the more the results and spreads take over.
2. Injuries. Players listed Out or Day-To-Day lower their team's rating for the
   games they're expected to miss, scaled by how productive they are.
3. Simulation. The rest of the regular season is played out thousands of times
   from the real remaining schedule, with some uncertainty in each team's
   rating. Each run builds the conference standings, plays the play-in
   (7 v 8, 9 v 10, then the loser of 7 v 8 against the 9 v 10 winner) and
   records who reached the playoffs.

The ESPN parts (rosters, injuries, schedule) are cached in data/ so a failed
request just reuses the last good copy.
"""
import json
import math
import os
import random
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons"
NAME_FIX = {"Los Angeles Clippers": "LA Clippers"}

ESPN_ID = {
    "Atlanta Hawks": 1, "Boston Celtics": 2, "New Orleans Pelicans": 3, "Chicago Bulls": 4,
    "Cleveland Cavaliers": 5, "Dallas Mavericks": 6, "Denver Nuggets": 7, "Detroit Pistons": 8,
    "Golden State Warriors": 9, "Houston Rockets": 10, "Indiana Pacers": 11, "LA Clippers": 12,
    "Los Angeles Lakers": 13, "Miami Heat": 14, "Milwaukee Bucks": 15, "Minnesota Timberwolves": 16,
    "Brooklyn Nets": 17, "New York Knicks": 18, "Orlando Magic": 19, "Philadelphia 76ers": 20,
    "Phoenix Suns": 21, "Portland Trail Blazers": 22, "Sacramento Kings": 23, "San Antonio Spurs": 24,
    "Oklahoma City Thunder": 25, "Utah Jazz": 26, "Washington Wizards": 27, "Toronto Raptors": 28,
    "Memphis Grizzlies": 29, "Charlotte Hornets": 30,
}
EAST = {
    "Atlanta Hawks", "Boston Celtics", "Brooklyn Nets", "Charlotte Hornets", "Chicago Bulls",
    "Cleveland Cavaliers", "Detroit Pistons", "Indiana Pacers", "Miami Heat", "Milwaukee Bucks",
    "New York Knicks", "Orlando Magic", "Philadelphia 76ers", "Toronto Raptors", "Washington Wizards",
}

SEASON_GAMES = 82
HCA = 2.5            # home-court advantage, points
GAME_SD = 12.0       # spread of a single game's margin around expectation
WINS_PER_POINT = 2.7  # ~2.7 extra wins over a season per point of rating
PRIOR_GAMES = 14.0   # the preseason line is worth this many games of results
SPREAD_WEIGHT = 3.0  # one betting spread counts as this many games of results
HALF_LIFE = 20.0     # games: older results fade with this half-life (momentum)
INJURY_SHARE = 0.7   # results and spreads already reflect some absences
SIMS = 5000


# ---------------------------------------------------------------- ESPN data
def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "nba-points-league/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_schedule(season, log):
    """Every regular-season game not yet played, from each team's schedule."""
    def one(item):
        team, tid = item
        return get(f"{SITE}/teams/{tid}/schedule?season={season}&seasontype=2").get("events", [])

    games, failed = {}, 0
    with ThreadPoolExecutor(8) as ex:
        for evs in ex.map(lambda it: _safe(one, it), ESPN_ID.items()):
            if evs is None:
                failed += 1
                continue
            for ev in evs:
                comp = (ev.get("competitions") or [{}])[0]
                st = ((comp.get("status") or ev.get("status") or {}).get("type") or {})
                if st.get("completed") or st.get("state") == "post":
                    continue
                side = {}
                for c in comp.get("competitors", []):
                    nm = (c.get("team") or {}).get("displayName")
                    side[c.get("homeAway")] = NAME_FIX.get(nm, nm)
                if side.get("home") in ESPN_ID and side.get("away") in ESPN_ID:
                    d = (ev.get("date") or "")[:10]
                    games[str(ev.get("id"))] = {"date": d, "away": side["away"], "home": side["home"]}
    log.append(f"odds: schedule {len(games)} games left ({failed} team requests failed)")
    if failed > 5:
        return None
    return sorted(games.values(), key=lambda g: (g["date"], g["home"]))


def _safe(fn, arg):
    try:
        return fn(arg)
    except Exception:
        return None


def fetch_injuries(season, log):
    """Injured players with how productive they are and what ESPN says about them."""
    # League-wide injury report: comments and expected return dates.
    report = {}
    try:
        for team in get(f"{SITE}/injuries").get("injuries", []):
            for inj in team.get("injuries", []):
                a = inj.get("athlete") or {}
                nm = a.get("displayName") or a.get("fullName")
                if nm:
                    det = inj.get("details") or {}
                    report[nm] = {
                        "status": inj.get("status") or (inj.get("type") or {}).get("description") or "",
                        "comment": inj.get("shortComment") or inj.get("longComment") or "",
                        "return": det.get("returnDate") or "",
                        "fantasy": ((det.get("fantasyStatus") or {}).get("description") or ""),
                    }
    except Exception as ex:
        log.append(f"odds: injury report failed: {ex!r}")

    # Rosters: who is hurt on each team (and their ESPN ids for stats).
    def roster(item):
        team, tid = item
        js = get(f"{SITE}/teams/{tid}/roster")
        lst = js.get("athletes") or []
        if lst and isinstance(lst[0], dict) and "items" in lst[0]:
            lst = [x for g in lst for x in g["items"]]
        out = []
        for a in lst:
            nm = a.get("displayName") or a.get("fullName") or ""
            injs = a.get("injuries") or []
            rep = report.get(nm)
            status = (rep or {}).get("status") or (injs[0].get("status") if injs else "")
            if status:
                out.append({"team": team, "id": str(a.get("id")), "name": nm, "status": status,
                            "comment": (rep or {}).get("comment", ""), "return": (rep or {}).get("return", ""),
                            "fantasy": (rep or {}).get("fantasy", "")})
        return out

    hurt, failed = [], 0
    with ThreadPoolExecutor(8) as ex:
        for res in ex.map(lambda it: _safe(roster, it), ESPN_ID.items()):
            if res is None:
                failed += 1
            else:
                hurt.extend(res)
    if failed > 5:
        log.append(f"odds: {failed} roster requests failed; keeping last injury list")
        return None

    # Per-game production: this season, else last season.
    def stats(p):
        for yr, recent in ((season, True), (season - 1, False)):
            try:
                js = get(f"{CORE}/{yr}/types/2/athletes/{p['id']}/statistics")
            except Exception:
                continue
            f = {}
            for c in (js.get("splits") or {}).get("categories", []):
                for s in c.get("stats", []):
                    f[s.get("name")] = s.get("value")
            gp = f.get("gamesPlayed") or 0
            if gp:
                return {"gp": gp, "min": f.get("avgMinutes") or 0, "pts": f.get("avgPoints") or 0,
                        "reb": f.get("avgRebounds") or 0, "ast": f.get("avgAssists") or 0, "this_season": recent}
        return None

    with ThreadPoolExecutor(8) as ex:
        for p, s in zip(hurt, ex.map(stats, hurt)):
            p["stats"] = s
    log.append(f"odds: {len(hurt)} injured players, {len(report)} in ESPN's report")
    return hurt


# ---------------------------------------------------------------- model
def player_impact(p):
    """Rating points (per game) a team loses without this player."""
    s = p.get("stats")
    if not s:
        return 0.0
    v = s["pts"] + 0.7 * s["reb"] + 0.7 * s["ast"]
    imp = max(0.0, 0.2 * (v - 8.0)) * min(1.0, (s["min"] or 0) / 30.0 + 0.2)
    if not s["this_season"]:
        imp *= 0.5   # hasn't played yet this season: results already reflect it
    return round(min(imp, 9.0), 2)


def games_missed(p, team_dates, today):
    """How many of the team's remaining games this player should miss."""
    st = (p.get("status") or "").lower()
    text = f"{p.get('comment', '')} {p.get('fantasy', '')}".lower()
    left = len(team_dates)
    if "season" in text and ("out for" in text or "ofs" in text or "remainder" in text):
        return left
    if p.get("return"):
        try:
            back = date.fromisoformat(p["return"][:10])
            return sum(1 for d in team_dates if d < back.isoformat())
        except ValueError:
            pass
    m = re.search(r"(\d+)\s*(?:-|to)\s*(\d+)\s*weeks?", text) or re.search(r"(\d+)\s*weeks?", text)
    if m and st.startswith("out"):
        wk = (int(m.group(1)) + int(m.group(m.lastindex))) / 2
        return min(left, round(wk * 3.5))
    if "day-to-day" in st or "day to day" in st or "questionable" in st:
        return min(left, 1)
    if st.startswith("out") or "doubtful" in st:
        return min(left, 5)
    return 0


def fit_ratings(teams, prior, games, lines, today):
    """Weighted least squares with the preseason line as a prior (ridge)."""
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    A = [[0.0] * n for _ in range(n)]
    b = [0.0] * n
    for t, i in idx.items():
        A[i][i] += PRIOR_GAMES
        b[i] += PRIOR_GAMES * prior[t]

    # Recency: weight by how many games ago, per team pair average.
    played = sorted((g for g in games if g.get("home_score") is not None), key=lambda g: g["date"])
    count = {t: 0 for t in teams}
    order = []
    for g in reversed(played):
        ah = count.get(g["home"], 0)
        aa = count.get(g["away"], 0)
        order.append((g, (ah + aa) / 2))
        count[g["home"]] = ah + 1
        count[g["away"]] = aa + 1
    weight_sum = {t: 0.0 for t in teams}

    def add(h, a, y, w):
        i, j = idx[h], idx[a]
        A[i][i] += w; A[j][j] += w; A[i][j] -= w; A[j][i] -= w
        b[i] += w * y; b[j] -= w * y
        weight_sum[h] += w; weight_sum[a] += w

    for g, ago in order:
        if g["home"] not in idx or g["away"] not in idx:
            continue
        margin = g["home_score"] - g["away_score"]
        margin = max(-25.0, min(25.0, margin))  # blowouts tell you less than the score says
        add(g["home"], g["away"], margin - HCA, 0.5 ** (ago / HALF_LIFE))

    cutoff = (today - timedelta(days=45)).isoformat()
    for l in lines:
        if l.get("spread") is None or not l.get("fav") or l["date"] < cutoff:
            continue
        if l["home"] not in idx or l["away"] not in idx:
            continue
        home_by = l["spread"] if l["fav"] == l["home"] else -l["spread"]
        days = (today - date.fromisoformat(l["date"])).days
        add(l["home"], l["away"], home_by - HCA, SPREAD_WEIGHT * 0.5 ** (days / 30.0))

    # Ratings are relative: pin the average to zero by adding a tiny pull.
    for i in range(n):
        for j in range(n):
            A[i][j] += 1e-3
    r = solve(A, b)
    mean = sum(r) / n
    r = [x - mean for x in r]
    sd = {t: math.sqrt(GAME_SD ** 2 / (PRIOR_GAMES + weight_sum[t]) + 0.8) for t in teams}
    return {t: r[idx[t]] for t in teams}, sd


def solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c and M[r][c]:
                f = M[r][c] / M[c][c]
                for k in range(c, n + 1):
                    M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] for i in range(n)]


def phi(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def compute(today, games, lines, projections, remaining, injuries, history):
    teams = sorted(ESPN_ID)
    prior = {t: 0.0 for t in teams}
    proj = {p["team"]: p["projected_wins"] for p in projections}
    for t in teams:
        if t in proj:
            prior[t] = (proj[t] - SEASON_GAMES / 2) / WINS_PER_POINT

    rating, sd = fit_ratings(teams, prior, games, lines, today)

    wins = {t: 0 for t in teams}
    losses = {t: 0 for t in teams}
    margins = {t: [] for t in teams}
    for g in sorted(games, key=lambda g: g["date"]):
        if g.get("home_score") is None or g["home"] not in wins or g["away"] not in wins:
            continue
        h = g["home_score"] > g["away_score"]
        wins[g["home"] if h else g["away"]] += 1
        losses[g["away"] if h else g["home"]] += 1
        m = g["home_score"] - g["away_score"]
        margins[g["home"]].append(m)
        margins[g["away"]].append(-m)

    # Only games that haven't been played (the schedule cache can lag a day).
    played_keys = {(g["date"], g["away"], g["home"]) for g in games}
    remaining = [g for g in remaining if (g["date"], g["away"], g["home"]) not in played_keys and g["date"] >= today.isoformat()]
    team_dates = {t: [] for t in teams}
    for g in remaining:
        team_dates[g["home"]].append(g["date"])
        team_dates[g["away"]].append(g["date"])

    # Injury cost per team, per remaining game (by the team's game number).
    inj_by_team = {t: [] for t in teams}
    penalty = {t: [0.0] * len(team_dates[t]) for t in teams}
    for p in injuries or []:
        t = p.get("team")
        if t not in penalty:
            continue
        imp = player_impact(p)
        miss = games_missed(p, team_dates[t], today)
        if imp <= 0 or miss <= 0:
            continue
        for k in range(min(miss, len(penalty[t]))):
            penalty[t][k] += imp * INJURY_SHARE
        inj_by_team[t].append({"name": p["name"], "status": p["status"], "games": miss, "impact": imp,
                               "comment": (p.get("comment") or "")[:140]})

    # Each remaining game: expected home margin before rating noise.
    seen = {t: 0 for t in teams}
    plan, cost = [], []
    for g in remaining:
        h, a = g["home"], g["away"]
        ph = penalty[h][seen[h]] if seen[h] < len(penalty[h]) else 0.0
        pa = penalty[a][seen[a]] if seen[a] < len(penalty[a]) else 0.0
        seen[h] += 1; seen[a] += 1
        plan.append((h, a, rating[h] - ph - (rating[a] - pa) + HCA))
        cost.append((ph, pa))

    # Wins each team is expected to lose to its own injuries (for the card).
    inj_wins = {t: 0.0 for t in teams}
    for (h, a, mu), (ph, pa) in zip(plan, cost):
        base = rating[h] - rating[a] + HCA
        inj_wins[h] -= phi(base / GAME_SD) - phi((base - ph) / GAME_SD)
        inj_wins[a] -= (1 - phi(base / GAME_SD)) - (1 - phi((base + pa) / GAME_SD))

    # Games not on the schedule yet (the two NBA Cup games set after group
    # play): count them as neutral-site games against an average team.
    AVG = "__avg__"
    rating[AVG], sd[AVG] = 0.0, 0.0
    for t in teams:
        for _ in range(max(0, SEASON_GAMES - wins[t] - losses[t] - len(team_dates[t]))):
            plan.append((t, AVG, rating[t]))

    # Monte Carlo.
    rng = random.Random(f"{today.isoformat()}|{len(games)}")
    made = {t: 0 for t in teams}
    top6 = {t: 0 for t in teams}
    playin = {t: 0 for t in teams}
    win_tot = {t: 0.0 for t in teams}
    seed_tot = {t: 0.0 for t in teams}
    confs = (sorted(EAST), sorted(set(teams) - EAST))
    inv = 1.0 / (GAME_SD * math.sqrt(2.0))
    erf = math.erf
    rand = rng.random
    for _ in range(SIMS):
        shock = {t: rng.gauss(0.0, sd[t]) for t in teams}
        shock[AVG] = 0.0
        w = dict(wins)
        w[AVG] = 0
        for h, a, mu in plan:
            p = 0.5 * (1.0 + erf((mu + shock[h] - shock[a]) * inv))
            if rand() < p:
                w[h] += 1
            else:
                w[a] += 1
        for conf in confs:
            ranked = sorted(conf, key=lambda t: (w[t], rand()), reverse=True)
            for s, t in enumerate(ranked, 1):
                seed_tot[t] += s
                win_tot[t] += w[t]
            for t in ranked[:6]:
                made[t] += 1
                top6[t] += 1
            s7, s8, s9, s10 = ranked[6:10]
            for t in (s7, s8, s9, s10):
                playin[t] += 1

            def beat(home, away):
                mu = rating[home] + shock[home] - rating[away] - shock[away] + HCA
                return home if rand() < phi(mu / GAME_SD) else away
            w78 = beat(s7, s8)
            l78 = s8 if w78 == s7 else s7
            w910 = beat(s9, s10)
            made[w78] += 1
            made[beat(l78, w910)] += 1

    # Change since the last saved day (history keeps one entry per day).
    prev = None
    for d in sorted(history or {}, reverse=True):
        if d < today.isoformat():
            prev = history[d]
            break

    out = {}
    left_sum = {t: len(team_dates[t]) for t in teams}
    opp = {t: [] for t in teams}
    for g in remaining:
        opp[g["home"]].append(rating[g["away"]])
        opp[g["away"]].append(rating[g["home"]])
    sos = {t: (sum(opp[t]) / len(opp[t]) if opp[t] else 0.0) for t in teams}
    sos_rank = {t: i for i, t in enumerate(sorted(teams, key=lambda t: -sos[t]), 1)}
    for t in teams:
        pct = 100.0 * made[t] / SIMS
        last5 = margins[t][-5:]
        out[t] = {
            "playoffs": round(pct, 1),
            "top6": round(100.0 * top6[t] / SIMS, 1),
            "playin": round(100.0 * playin[t] / SIMS, 1),
            "proj_w": round(win_tot[t] / SIMS, 1),
            "proj_l": round(SEASON_GAMES - win_tot[t] / SIMS, 1),
            "seed": round(seed_tot[t] / SIMS, 1),
            "conf": "East" if t in EAST else "West",
            "rating": round(rating[t], 1),
            "rating_wins": round(SEASON_GAMES / 2 + rating[t] * WINS_PER_POINT, 1),
            "prior_wins": proj.get(t),
            "last5_margin": round(sum(last5) / len(last5), 1) if last5 else None,
            "season_margin": round(sum(margins[t]) / len(margins[t]), 1) if margins[t] else None,
            "injuries": sorted(inj_by_team[t], key=lambda x: -x["impact"] * x["games"])[:4],
            "injury_wins": round(inj_wins[t], 1),
            "sos_rank": sos_rank[t],
            "games_left": SEASON_GAMES - wins[t] - losses[t],
            "prev": (prev or {}).get(t),
        }
    return out
