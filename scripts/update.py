#!/usr/bin/env python3
"""Refresh the league's data files from ESPN's public NBA scoreboard.

Runs on a schedule in GitHub Actions. It rebuilds the season's results from
scratch on every run (so a missed run heals itself), saves each game's last
pregame betting line, writes today's slate (with live scores), and fills in
playoff / NBA Cup bonuses automatically.

No third-party packages: standard library only.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PT = ZoneInfo("America/Los_Angeles")
API = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"

# ESPN team names that differ from the names this league uses.
NAME_FIX = {"Los Angeles Clippers": "LA Clippers"}


def load(name, default=None):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def save(name, obj):
    """Write a data file only if its content changed. Returns True if it did."""
    path = os.path.join(DATA, name)
    new = json.dumps(obj, indent=1, ensure_ascii=False) + "\n"
    old = open(path).read() if os.path.exists(path) else None
    if new == old:
        return False
    with open(path, "w") as f:
        f.write(new)
    return True


def fetch(dates):
    url = f"{API}?dates={dates}&limit=1000"
    req = urllib.request.Request(url, headers={"User-Agent": "nba-points-league/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def num(x):
    """'-155' / -155 / '+130' / 'EVEN' -> number or None."""
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return x
    s = str(x).strip().upper().replace("+", "")
    if s in ("EVEN", "EV", "PK", "PICK"):
        return 100
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


def parse_event(ev):
    comp = (ev.get("competitions") or [{}])[0]
    st = (comp.get("status") or ev.get("status") or {}).get("type", {})
    teams = {}
    for c in comp.get("competitors", []):
        t = c.get("team", {})
        name = NAME_FIX.get(t.get("displayName"), t.get("displayName"))
        teams[c.get("homeAway")] = {
            "name": name,
            "abbr": t.get("abbreviation", ""),
            "score": num(c.get("score")),
            "winner": bool(c.get("winner")),
        }
    if "home" not in teams or "away" not in teams:
        return None
    start = datetime.fromisoformat(ev["date"].replace("Z", "+00:00"))
    notes = " ".join(n.get("headline", "") for n in comp.get("notes", []) or [])
    season_type = (ev.get("season") or {}).get("type")
    return {
        "id": str(ev.get("id")),
        "start": start,
        "date": start.astimezone(PT).date().isoformat(),
        "time": start.astimezone(PT).strftime("%-I:%M %p"),
        "state": st.get("state"),  # pre / in / post
        "completed": bool(st.get("completed")),
        "detail": st.get("shortDetail") or st.get("detail") or "",
        "season_type": season_type,  # 2 regular season, 3 playoffs, 5 play-in
        "notes": notes,
        "home": teams["home"],
        "away": teams["away"],
        "odds": parse_odds(comp.get("odds") or [], teams),
    }


def is_cup_game(e):
    """NBA Cup group-play and knockout games ("NBA Cup - Group Play", "NBA Cup - Quarterfinals", ...).
    The Cup championship isn't a regular-season game, so it's left out."""
    n = (e.get("notes") or "").lower()
    return "nba cup" in n and "championship" not in n


def parse_odds(odds, teams):
    if not odds:
        return None
    o = odds[0]
    hml = num((o.get("homeTeamOdds") or {}).get("moneyLine"))
    aml = num((o.get("awayTeamOdds") or {}).get("moneyLine"))
    ml = o.get("moneyline") or {}
    for side, cur in (("home", hml), ("away", aml)):
        if cur is None and ml.get(side):
            m = ml[side]
            val = num((m.get("close") or {}).get("odds")) or num((m.get("current") or {}).get("odds")) or num((m.get("open") or {}).get("odds"))
            if side == "home":
                hml = val
            else:
                aml = val
    details = (o.get("details") or "").strip()
    fav, spread = "", None
    m = re.match(r"^([A-Z]{2,4})\s*([-+]?\d+(\.\d+)?)$", details)
    if m:
        abbr = m.group(1)
        for side in ("home", "away"):
            if teams[side]["abbr"] == abbr:
                fav = teams[side]["name"]
        spread = abs(float(m.group(2)))
    elif details.upper() in ("EVEN", "PK", "PICK"):
        spread = 0.0
    if not fav and hml is not None and aml is not None:
        fav = teams["home"]["name"] if hml < aml else teams["away"]["name"]
    if spread is None and o.get("spread") is not None:
        spread = abs(float(o["spread"]))
    if hml is None and aml is None and spread is None:
        return None
    return {
        "fav": fav,
        "spread": spread,
        "away_ml": aml,
        "home_ml": hml,
        "book": ((o.get("provider") or {}).get("name")) or "ESPN",
    }


def main():
    cfg = load("config.json")
    now = datetime.now(timezone.utc)
    today = now.astimezone(PT).date()
    start = datetime.fromisoformat(cfg["season_start"]).date()
    end = today + timedelta(days=1)

    events = []
    log = []

    def add(data):
        for ev in data.get("events", []):
            try:
                p = parse_event(ev)
            except Exception as ex:  # one odd event shouldn't sink the run
                log.append(f"skipped event {ev.get('id')}: {ex!r}")
                continue
            if p:
                events.append(p)

    # ESPN's scoreboard takes one date per request. Re-check the last 3 days
    # every run; once a night (the 1 AM Pacific run) re-check the last 14; on
    # the very first run, or when FULL_REFRESH=1, pull the whole season.
    local_now = now.astimezone(PT)
    have_games = bool(load("games.json", []))
    if os.environ.get("FULL_REFRESH") == "1" or not have_games:
        first = start
    elif local_now.hour == 1:
        first = max(start, today - timedelta(days=14))
    else:
        first = max(start, today - timedelta(days=3))
    day = first
    while day <= end:
        try:
            add(fetch(f"{day:%Y%m%d}"))
        except Exception as ex:
            log.append(f"day {day} failed: {ex!r}")
        day += timedelta(days=1)
    log.append(f"checked {first} through {end}")
    # De-duplicate (a game can appear in two overlapping responses).
    events = list({e["id"]: e for e in events}.values())
    log.append(f"fetched {len(events)} events")
    if not events:
        log.append("ESPN returned no events; data left unchanged.")
        write_log(now, "error", log)
        print("\n".join(log))
        return 1

    teams = {r["team"] for r in load("rosters.json")}
    unknown = sorted({e[s]["name"] for e in events for s in ("home", "away")} - teams)
    if unknown:
        print("WARNING: team names not in rosters:", unknown)

    changed = []

    # 1. Regular-season results (NBA Cup group games count; the Cup final does not).
    old_games = {(g["date"], g["away"], g["home"]): g for g in load("games.json", [])}
    games = dict(old_games)
    for e in events:
        if e["season_type"] != 2 or not e["completed"]:
            continue
        if "cup" in e["notes"].lower() and "championship" in e["notes"].lower():
            continue
        key = (e["date"], e["away"]["name"], e["home"]["name"])
        games[key] = {
            "id": e["id"], "date": e["date"],
            "away": e["away"]["name"], "home": e["home"]["name"],
            "away_score": e["away"]["score"], "home_score": e["home"]["score"],
        }
        if is_cup_game(e):
            games[key]["cup"] = True
    games_list = sorted(games.values(), key=lambda g: (g["date"], g["home"]))
    if save("games.json", games_list):
        changed.append(f"games ({len(games_list) - len(old_games)} new)")

    # 2. Betting lines: keep the latest pregame line for every game, forever.
    lines = {(l["date"], l["away"], l["home"]): l for l in load("lines.json", [])}
    for e in events:
        if e["state"] == "pre" and e["odds"]:
            key = (e["date"], e["away"]["name"], e["home"]["name"])
            lines[key] = {"date": e["date"], "away": e["away"]["name"], "home": e["home"]["name"], **e["odds"]}
    if save("lines.json", sorted(lines.values(), key=lambda l: (l["date"], l["home"]))):
        changed.append("lines")

    # 3. Today's slate, with live scores (the page also refreshes these itself).
    todays = sorted((e for e in events if e["date"] == today.isoformat()), key=lambda e: e["start"])
    slate = {
        "date": today.isoformat(),
        "games": [{
            "id": e["id"], "time": e["time"], "state": e["state"], "detail": e["detail"],
            "away": e["away"]["name"], "home": e["home"]["name"],
            "away_score": e["away"]["score"] if e["state"] != "pre" else None,
            "home_score": e["home"]["score"] if e["state"] != "pre" else None,
            "cup": is_cup_game(e),
        } for e in todays],
    }
    if save("today.json", slate):
        changed.append("today")

    # 4. Bonuses, worked out from playoff and Cup games.
    bonuses = {b["team"]: b for b in load("bonuses.json", [])}
    stored = {p["id"]: p for p in load("playoff_games.json", [])}
    for e in events:
        if e["season_type"] == 3:
            stored[e["id"]] = {"id": e["id"], "date": e["date"], "completed": e["completed"],
                               "home": {"name": e["home"]["name"], "winner": e["home"]["winner"]},
                               "away": {"name": e["away"]["name"], "winner": e["away"]["winner"]}}
    if stored and save("playoff_games.json", sorted(stored.values(), key=lambda p: (p["date"], p["id"]))):
        changed.append("playoff games")
    playoff = list(stored.values())
    for b in bonuses.values():
        b["made_playoffs"] = max(b.get("made_playoffs", 0), int(any(b["team"] in (e["home"]["name"], e["away"]["name"]) for e in playoff)))
        wins = sum(1 for e in playoff if e["completed"] and ((e["home"]["winner"] and e["home"]["name"] == b["team"]) or (e["away"]["winner"] and e["away"]["name"] == b["team"])))
        b["playoff_wins"] = max(b.get("playoff_wins", 0), wins)
        series = {}
        for e in playoff:
            if not e["completed"]:
                continue
            pair = tuple(sorted((e["home"]["name"], e["away"]["name"])))
            w = e["home"]["name"] if e["home"]["winner"] else e["away"]["name"]
            series.setdefault(pair, {}).setdefault(w, 0)
            series[pair][w] += 1
        b["series_won"] = max(b.get("series_won", 0), sum(1 for pair, s in series.items() if s.get(b["team"], 0) >= 4))
    for e in events:
        n = e["notes"].lower()
        if e["completed"] and "cup" in n and "championship" in n:
            w = e["home"]["name"] if e["home"]["winner"] else e["away"]["name"]
            if w in bonuses:
                bonuses[w]["won_cup"] = 1
    if save("bonuses.json", list(bonuses.values())):
        changed.append("bonuses")

    # 5. Upcoming games (next ~2 weeks) for each team's "next 3" on the rosters.
    #    Refreshed once an hour (and whenever the date rolls over) to keep requests low.
    sched = load("schedule.json") or {}
    if sched.get("as_of") != today.isoformat() or local_now.minute < 15:
        upcoming = {e["id"]: e for e in events if e["state"] == "pre" and e["date"] >= today.isoformat()}
        day, ok = end + timedelta(days=1), True
        while day <= today + timedelta(days=14):
            try:
                for ev in fetch(f"{day:%Y%m%d}").get("events", []):
                    p = parse_event(ev)
                    if p and p["state"] == "pre":
                        upcoming[p["id"]] = p
            except Exception as ex:
                ok = False
                log.append(f"schedule day {day} failed: {ex!r}")
            day += timedelta(days=1)
        def sched_row(e):
            row = {"date": e["date"], "time": e["time"], "away": e["away"]["name"], "home": e["home"]["name"]}
            if is_cup_game(e):
                row["cup"] = True
            o = e.get("odds") or {}
            if o.get("away_ml") is not None or o.get("home_ml") is not None:
                row.update({"away_ml": o.get("away_ml"), "home_ml": o.get("home_ml")})
            return row
        games_next = sorted((sched_row(e) for e in upcoming.values() if e["season_type"] in (2, 3, 5)),
                            key=lambda g: (g["date"], g["home"]))
        if ok or not sched:
            if save("schedule.json", {"as_of": today.isoformat(), "games": games_next}):
                changed.append("schedule")

    # 6. Playoff odds. The full remaining schedule is refreshed once a day and
    #    the injury list every 3 hours; the odds are recomputed from them each run
    #    (they only change when an input does).
    try:
        import odds
        season = int(cfg["season_start"][:4]) + 1
        rest = load("season_schedule.json") or {}
        if rest.get("as_of") != today.isoformat() or not all("time" in g for g in (rest.get("games") or [])[:1]):
            got = odds.fetch_schedule(season, log)
            if got is not None:
                rest = {"as_of": today.isoformat(), "games": got}
                save("season_schedule.json", rest)
        inj = load("injuries.json") or {}
        stamp = f"{today.isoformat()}T{local_now.hour // 3 * 3:02d}"
        if inj.get("as_of") != stamp:
            got = odds.fetch_injuries(season, log)
            if got is not None:
                inj = {"as_of": stamp, "players": got}
                if save("injuries.json", inj):
                    changed.append("injuries")
        if rest.get("games"):
            hist = load("odds_history.json", {})
            table = odds.compute(today, games_list, load("lines.json", []), load("projections.json", []),
                                 rest["games"], inj.get("players") or [], hist)
            hist[today.isoformat()] = {t: v["playoffs"] for t, v in table.items()}
            hist = {d: hist[d] for d in sorted(hist)[-45:]}
            save("odds_history.json", hist)
            if save("odds.json", {"as_of": today.isoformat(), "sims": odds.SIMS, "teams": table}):
                changed.append("odds")
    except Exception as ex:
        log.append(f"odds failed: {ex!r}")

    # TEMP: capture one ESPN game summary so the site's box score view can be built against the real format
    try:
        if not os.path.exists(os.path.join(DATA, "sample_summary.json")):
            done = [g for g in games_list if g.get("id")][-1]
            req = urllib.request.Request(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={done['id']}", headers={"User-Agent": "nba-points-league/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                js = json.load(r)
            keep = {k: js.get(k) for k in ("header", "boxscore", "leaders", "gameInfo", "predictor", "winprobability") if k in js}
            if "winprobability" in keep and isinstance(keep["winprobability"], list):
                keep["winprobability"] = keep["winprobability"][:3]
            keep["_top_keys"] = list(js.keys())
            save("sample_summary.json", keep)
    except Exception as ex:
        log.append(f"sample summary failed: {ex!r}")

    if changed:
        save("meta.json", {"updated": now.isoformat(timespec="seconds"), "changed": changed})
    log.append("changed: " + (", ".join(changed) if changed else "nothing"))
    write_log(now, "ok", log)
    print("\n".join(log))
    return 0


def write_log(now, status, lines):
    with open(os.path.join(DATA, "update_log.txt"), "w") as f:
        f.write(f"{now.isoformat(timespec='seconds')} {status}\n" + "\n".join(lines) + "\n")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        import traceback
        tb = traceback.format_exc()
        print(tb)
        write_log(datetime.now(timezone.utc), "crash", [tb])
        sys.exit(1)
