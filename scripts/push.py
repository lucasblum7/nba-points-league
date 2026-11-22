#!/usr/bin/env python3
"""Push notifications through OneSignal, sent from the score updater.

Each subscribed phone is tagged with its owner (owner=Lucas), so every message
goes only to the owner it is about. Three kinds:
  - final: one of your teams just finished ("Lakers won 112-104 · +1 for you")
  - soon:  one of your teams tips off within ~40 minutes
  - recap: once the night's last game is final, your night in one message

data/push_log.json remembers what was sent, so nothing goes out twice even
though the updater re-checks the same games every run.

Needs the App ID in data/config.json ("onesignal_app_id") and the REST API key
in the ONESIGNAL_API_KEY environment variable (a GitHub Actions secret).
Without both, messages are only logged, never sent.
"""
import json
import os
import urllib.request
from datetime import date, datetime, timedelta

API = "https://api.onesignal.com/notifications?c=push"
SITE = "https://lucasblum7.github.io/nba-points-league/"
SOON_MIN = 40       # "starting soon" window, minutes before tip-off
KEEP_DAYS = 10      # how long sent-message ids are remembered


def short(team):
    parts = team.split()
    if team.endswith("Trail Blazers"):
        return "Trail Blazers"
    return parts[-1]


def send(app_id, key, owner, title, body, log, sent):
    msg = {"app_id": app_id, "target_channel": "push",
           "filters": [{"field": "tag", "key": "owner", "relation": "=", "value": owner}],
           "headings": {"en": title}, "contents": {"en": body}, "url": SITE}
    if not (app_id and key):
        log.append(f"push (not sent, no key): {owner}: {title} | {body}")
        return True
    req = urllib.request.Request(API, data=json.dumps(msg).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Key {key}",
                                          "User-Agent": "nba-points-league/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
        sent[0] += 1
        return True
    except Exception as ex:
        log.append(f"push failed for {owner}: {ex!r}")
        return False


def run(cfg, rosters, games, bonuses, events, today, now_utc, pt, load, save, log):
    app_id = cfg.get("onesignal_app_id") or ""
    key = os.environ.get("ONESIGNAL_API_KEY", "")
    if not app_id:
        return
    owner = {r["team"]: r["owner"] for r in rosters}
    owners = sorted(set(owner.values()))
    S = cfg.get("scoring", {})
    win, cup_win = S.get("win", 1), S.get("cup_game_win", 2)
    count = [0]
    plog = load("push_log.json", {}) or {}
    test_to = os.environ.get("PUSH_TEST", "").strip()
    if test_to:   # manual test from the Actions tab
        kind = os.environ.get("PUSH_TEST_KIND", "").strip()
        if kind == "upset":
            title, body = "🚨 Upset! Kings won (test)", "Kings beat the Celtics 97–96 as a +446 underdog. +1 for you. (This is a test alert.)"
        else:
            title, body = "Hoop Squads alerts are on 🏀", "This is a test. You'll get finals, tip-off reminders and a nightly recap for your teams."
        ok = send(app_id, key, test_to, title, body, log, count)
        log.append(f"push test to {test_to}: {'sent' if ok and key else 'not sent (missing key)' if not key else 'failed'}")
    sent_ids = plog.get("sent", {})

    def once(eid, who, title, body):
        if eid in sent_ids:
            return
        if send(app_id, key, who, title, body, log, count):
            sent_ids[eid] = today.isoformat()

    cutoff = (today - timedelta(days=1)).isoformat()
    # pregame moneylines, for upset alerts (an underdog at +350 or longer, the league's upset watch line)
    ml = {}
    for ln in load("lines.json", []) or []:
        ml[(ln["date"], ln["away"], ln["home"])] = (ln.get("away_ml"), ln.get("home_ml"))
    tiers = sorted(cfg.get("upset_tiers") or [], key=lambda t: -t.get("min", 0))
    def upset_label(g, winner):
        a, h = ml.get((g["date"], g["away"], g["home"]), (None, None))
        v = h if winner == g["home"] else a
        try:
            v = float(v)
        except (TypeError, ValueError):
            return None
        for t in tiers:
            if v >= t.get("min", 10**9):
                return t.get("label", "Upset"), int(v)
        return None
    # first run after push is switched on: mark recent finals as already sent, so phones don't get a burst of old scores
    if not plog.get("started"):
        for g in games:
            if g["date"] >= cutoff:
                for t in (g["home"], g["away"]):
                    if owner.get(t):
                        sent_ids[f"final|{g['id']}|{owner[t]}"] = today.isoformat()
        plog["started"] = today.isoformat()
    # 1. finals for your teams (only last night / today, so old games never fire)
    for g in games:
        if g["date"] < cutoff or g.get("home_score") is None:
            continue
        hw = g["home_score"] > g["away_score"]
        w, l = (g["home"], g["away"]) if hw else (g["away"], g["home"])
        ws, ls = max(g["home_score"], g["away_score"]), min(g["home_score"], g["away_score"])
        pts = cup_win if g.get("cup") else win
        cup = " 🏆" if g.get("cup") else ""
        ow, ol = owner.get(w), owner.get(l)
        if ow and ow == ol:
            once(f"final|{g['id']}|{ow}", ow, f"{short(w)} beat {short(l)}{cup}", f"{short(w)} won {ws}–{ls}. Both yours, so +{pts} either way.")
            continue
        up = upset_label(g, w)
        if ow:
            if up:
                once(f"final|{g['id']}|{ow}", ow, f"🚨 {up[0]}! {short(w)} won{cup}", f"{short(w)} beat the {short(l)} {ws}–{ls} as a +{up[1]} underdog. +{pts} for you.")
            else:
                once(f"final|{g['id']}|{ow}", ow, f"{short(w)} won{cup}", f"{short(w)} beat the {short(l)} {ws}–{ls}. +{pts} for you.")
        if ol:
            once(f"final|{g['id']}|{ol}", ol, f"{short(l)} lost{cup}" + (" in an upset" if up else ""), f"{short(l)} fell to the {short(w)} {ls}–{ws}.")

    # 2. starting soon
    for e in events:
        if e.get("state") != "pre" or e["date"] != today.isoformat():
            continue
        mins = (e["start"] - now_utc).total_seconds() / 60
        if not (0 < mins <= SOON_MIN):
            continue
        a, h = e["away"]["name"], e["home"]["name"]
        for t in (a, h):
            o = owner.get(t)
            if not o:
                continue
            opp = h if t == a else a
            where = "vs" if t == h else "@"
            cup = " 🏆 NBA Cup, wins count 2" if "nba cup" in (e.get("notes") or "").lower() else ""
            once(f"soon|{e['id']}|{o}", o, (f"{short(t)} tip off soon" if short(t).endswith("s") else f"{short(t)} tips off soon"), f"{short(t)} {where} {short(opp)} at {e['time']} PT.{cup}")

    # 3. nightly recap, once every game on today's slate is final
    todays = [e for e in events if e["date"] == today.isoformat() and e.get("season_type") in (2, 3)]
    if todays and all(e.get("completed") for e in todays) and f"recap|{today.isoformat()}" not in plog.get("recaps", []):
        # points and rank
        pts = {o: 0 for o in owners}
        for g in games:
            hw = g["home_score"] > g["away_score"]
            w = g["home"] if hw else g["away"]
            if owner.get(w):
                pts[owner[w]] += cup_win if g.get("cup") else win
        for b in bonuses:
            o = owner.get(b["team"])
            if o:
                pts[o] += S.get("made_playoffs", 5) * b.get("made_playoffs", 0) + S.get("playoff_win", 2) * b.get("playoff_wins", 0) + S.get("won_cup", 5) * b.get("won_cup", 0)
        tonight = {o: [0, 0] for o in owners}
        for g in games:
            if g["date"] != today.isoformat():
                continue
            hw = g["home_score"] > g["away_score"]
            w, l = (g["home"], g["away"]) if hw else (g["away"], g["home"])
            if owner.get(w):
                tonight[owner[w]][0] += cup_win if g.get("cup") else win
            if owner.get(l):
                tonight[owner[l]][1] += 1
        # this week's matchup net (Cup games count double both ways)
        M = cfg.get("matchups") or {}
        week1 = date.fromisoformat(cfg["week1_monday"])
        wk = (today - week1).days // 7 + 1
        start = week1 + timedelta(days=(wk - 1) * 7)
        net = {o: 0 for o in owners}
        for g in games:
            d = date.fromisoformat(g["date"])
            if not (start <= d <= today):
                continue
            hw = g["home_score"] > g["away_score"]
            w, l = (g["home"], g["away"]) if hw else (g["away"], g["home"])
            wt = 2 if g.get("cup") else 1
            if owner.get(w):
                net[owner[w]] += wt
            if owner.get(l):
                net[owner[l]] -= wt
        opp = {}
        if M.get("rounds") and wk >= M.get("start_week", 1):
            for a, b in M["rounds"][(wk - M.get("start_week", 1)) % len(M["rounds"])]:
                opp[a], opp[b] = b, a
        order = sorted(owners, key=lambda o: -pts[o])
        sign = lambda n: f"+{n}" if n > 0 else (f"−{abs(n)}" if n < 0 else "0")
        ordn = lambda n: f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"
        for o in owners:
            w_pts, losses = tonight[o]
            if w_pts == 0 and losses == 0:
                continue   # no games tonight for this owner
            place = 1 + sum(1 for x in owners if pts[x] > pts[o])
            tied = sum(1 for x in owners if pts[x] == pts[o]) > 1
            line = (f"+{w_pts} tonight" if w_pts else "No wins tonight") + f" · {pts[o]} pts, {'T-' if tied else ''}{ordn(place)} of {len(owners)}."
            if o in opp:
                p = opp[o]
                lead = "lead" if net[o] > net[p] else "trail" if net[o] < net[p] else "are tied with"
                line += f" Week {wk}: you {lead} {p} {sign(net[o])} to {sign(net[p])}." if lead != "are tied with" else f" Week {wk}: tied with {p} at {sign(net[o])}."
            once(f"recap|{today.isoformat()}|{o}", o, "Tonight in Hoop Squads", line)
        plog.setdefault("recaps", []).append(f"recap|{today.isoformat()}")

    # forget old ids so the log stays small
    keep = (today - timedelta(days=KEEP_DAYS)).isoformat()
    plog["sent"] = {k: v for k, v in sent_ids.items() if v >= keep}
    plog["recaps"] = [r for r in plog.get("recaps", []) if r.split("|")[1] >= keep]
    save("push_log.json", plog)
    if count[0]:
        log.append(f"push: sent {count[0]} notification(s)")
