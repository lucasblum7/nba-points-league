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


ABBR = {"Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN", "Charlotte Hornets": "CHA", "Chicago Bulls": "CHI",
        "Cleveland Cavaliers": "CLE", "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN", "Detroit Pistons": "DET", "Golden State Warriors": "GSW",
        "Houston Rockets": "HOU", "Indiana Pacers": "IND", "LA Clippers": "LAC", "Los Angeles Lakers": "LAL", "Memphis Grizzlies": "MEM",
        "Miami Heat": "MIA", "Milwaukee Bucks": "MIL", "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NOP", "New York Knicks": "NYK",
        "Oklahoma City Thunder": "OKC", "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI", "Phoenix Suns": "PHX", "Portland Trail Blazers": "POR",
        "Sacramento Kings": "SAC", "San Antonio Spurs": "SAS", "Toronto Raptors": "TOR", "Utah Jazz": "UTA", "Washington Wizards": "WAS"}


def ab(team):
    return ABBR.get(team, short(team))


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


SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event="
_sum_cache = {}


def summary(eid, log):
    """ESPN's game page data (box score, injury report); cached per run, None on failure."""
    if eid in _sum_cache:
        return _sum_cache[eid]
    js = None
    try:
        req = urllib.request.Request(SUMMARY + str(eid), headers={"User-Agent": "Mozilla/5.0 (hoop-squads)"})
        with urllib.request.urlopen(req, timeout=20) as r:
            js = json.loads(r.read().decode())
    except Exception as ex:
        log.append(f"push: summary {eid} failed: {ex!r}")
    _sum_cache[eid] = js
    return js


def nm(full):
    """'Cade Cunningham' -> 'C. Cunningham'"""
    p = (full or "").split()
    return f"{p[0][0]}. {' '.join(p[1:])}" if len(p) > 1 else (full or "")


def box_lines(js):
    """team name -> [ {id, name, pts, reb, ast, threes} ] from a summary's box score"""
    out = {}
    for tb in ((js or {}).get("boxscore") or {}).get("players") or []:
        team = ESPN_FIX.get(tb["team"]["displayName"], tb["team"]["displayName"])
        st = (tb.get("statistics") or [{}])[0]
        keys = st.get("keys") or []
        def ix(k):
            return keys.index(k) if k in keys else None
        ip, ir, ia, i3 = ix("points"), ix("rebounds"), ix("assists"), ix("threePointFieldGoalsMade-threePointFieldGoalsAttempted")
        rows = []
        for a in st.get("athletes") or []:
            v = a.get("stats") or []
            if not v or a.get("didNotPlay"):
                continue
            def num(i):
                try:
                    return int(v[i])
                except (TypeError, ValueError, IndexError):
                    return 0
            rows.append({"id": a["athlete"]["id"], "name": a["athlete"]["displayName"], "pts": num(ip), "reb": num(ir), "ast": num(ia),
                         "threes": (v[i3] if i3 is not None and i3 < len(v) else "").replace("-", "/")})
        out[team] = rows
    return out


def stat_line(p):
    bits = [f"{p['pts']} pts", f"{p['reb']} reb", f"{p['ast']} ast"]
    if p.get("threes") and not p["threes"].startswith("0/"):
        bits.append(f"{p['threes']} 3PT")
    return " · ".join(bits)


ESPN_FIX = {"Los Angeles Clippers": "LA Clippers"}


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
        if kind in ("recap", "samples", "more", "new"):
            pass   # handled below: builds the real recap for the latest game day, sent to this owner only
        elif kind == "upset":
            title, body = "🚨 Upset! Kings won (test)", "Kings beat the Celtics 97–96 as a +446 underdog. +1 for you. (This is a test alert.)"
        else:
            title, body = "Hoop Squads alerts are on 🏀", "This is a test. You'll get finals, tip-off reminders and a nightly recap for your teams."
        ok = True
        if kind not in ("recap", "samples", "more", "new"):
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
    # shared context: season points and this week's matchup, for every alert
    sign = lambda n: f"+{n}" if n > 0 else (f"−{abs(n)}" if n < 0 else "0")
    ordn = lambda n: f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"
    def season_pts():
        P = {o: 0 for o in owners}
        for g in games:
            w = g["home"] if g["home_score"] > g["away_score"] else g["away"]
            if owner.get(w):
                P[owner[w]] += cup_win if g.get("cup") else win
        for bb in bonuses:
            o = owner.get(bb["team"])
            if o:
                P[o] += S.get("made_playoffs", 5) * bb.get("made_playoffs", 0) + S.get("playoff_win", 2) * bb.get("playoff_wins", 0) + S.get("won_cup", 5) * bb.get("won_cup", 0)
        return P
    PTS = season_pts()
    def pts_line(o):
        place = 1 + sum(1 for x in owners if PTS[x] > PTS[o]); tied = sum(1 for x in owners if PTS[x] == PTS[o]) > 1
        return f"📊 {PTS[o]} pts, {'T-' if tied else ''}{ordn(place)} of {len(owners)}"
    def week_line(o, day):
        M = cfg.get("matchups") or {}
        week1 = date.fromisoformat(cfg["week1_monday"]); wk = (day - week1).days // 7 + 1
        if not M.get("rounds") or wk < M.get("start_week", 1):
            return None
        start = week1 + timedelta(days=(wk - 1) * 7)
        opp = {}
        for a_, b_ in M["rounds"][(wk - M.get("start_week", 1)) % len(M["rounds"])]:
            opp[a_], opp[b_] = b_, a_
        if o not in opp:
            return None
        net = {o: 0, opp[o]: 0}
        for g in games:
            d = date.fromisoformat(g["date"])
            if not (start <= d <= day):
                continue
            hw = g["home_score"] > g["away_score"]
            w, l = (g["home"], g["away"]) if hw else (g["away"], g["home"])
            wt = 2 if g.get("cup") else 1
            if owner.get(w) in net: net[owner[w]] += wt
            if owner.get(l) in net: net[owner[l]] -= wt
        p_ = opp[o]; dd = net[o] - net[p_]
        state = f"up {dd}" if dd > 0 else f"down {abs(dd)}" if dd < 0 else "all square"
        return f"⚔️ Week {wk} vs {p_}: {state} ({sign(net[o])} to {sign(net[p_])})"
    def ctx(o, day):
        return [x for x in (pts_line(o), week_line(o, day)) if x]

    def final_msgs(g):
        """(owner, title, body) for each owner with a team in this final."""
        hw = g["home_score"] > g["away_score"]
        w, l = (g["home"], g["away"]) if hw else (g["away"], g["home"])
        ws, ls = max(g["home_score"], g["away_score"]), min(g["home_score"], g["away_score"])
        pts = cup_win if g.get("cup") else win
        cup = " 🏆" if g.get("cup") else ""
        score = f"🏀 {ab(w)} {ws}, {ab(l)} {ls}" + (" · NBA Cup" if g.get("cup") else "")
        day = date.fromisoformat(g["date"])
        ow, ol = owner.get(w), owner.get(l)
        out = []
        if ow and ow == ol:
            out.append((ow, f"🤝 {short(w)} beat {short(l)} · +{pts}{cup}", "\n".join([score + " · both yours"] + ctx(ow, day))))
            return out
        up = upset_label(g, w)
        if ow:
            if up:
                out.append((ow, f"🚨 {up[0]}! {short(w)} win · +{pts}{cup}", "\n".join([score, f"💰 Won as a +{up[1]} underdog"] + ctx(ow, day))))
            else:
                out.append((ow, f"✅ {short(w)} win · +{pts}{cup}", "\n".join([score] + ctx(ow, day))))
        if ol:
            if up:
                out.append((ol, f"😬 {short(l)} lose in an upset{cup}", "\n".join([score, f"💰 {ab(w)} were +{up[1]} underdogs"] + ctx(ol, day))))
            else:
                out.append((ol, f"❌ {short(l)} lose{cup}", "\n".join([score] + ctx(ol, day))))
        return out

    try:
        import odds as _o2
        _imp = _o2.player_impact
    except Exception:
        _imp = lambda p_: 0
    _inj_by_id = {str(p_.get("id")): p_ for p_ in ((load("injuries.json", {}) or {}).get("players") or [])}

    def injury_report(eid, teams):
        """Pre-game injury lines for these teams, from ESPN's game page (freshest report)."""
        js = summary(eid, log) if eid else None
        if not js:
            return []
        by_team = {}
        for tb in js.get("injuries") or []:
            team = ESPN_FIX.get(tb["team"]["displayName"], tb["team"]["displayName"])
            outs, gtd = [], []
            for i in tb.get("injuries") or []:
                ath = i.get("athlete") or {}
                stt = (i.get("status") or "").lower()
                fs = (((i.get("details") or {}).get("fantasyStatus") or {}).get("abbreviation") or "").upper()
                rank = _imp(_inj_by_id.get(str(ath.get("id")), {}))
                if stt.startswith("out") or fs == "OUT":
                    outs.append((rank, nm(ath.get("displayName"))))
                elif fs in ("GTD", "Q", "D") or "day-to-day" in stt or "questionable" in stt or "doubtful" in stt:
                    gtd.append((rank, nm(ath.get("displayName"))))
            by_team[team] = (sorted(outs, reverse=True), sorted(gtd, reverse=True))
        lines = []
        for t in teams:
            outs, gtd = by_team.get(t, ([], []))
            if not outs and not gtd:
                lines.append(f"✅ {ab(t)}: no injuries listed")
                continue
            parts = []
            if outs:
                parts.append("out " + ", ".join(n for _, n in outs[:3]) + (f" +{len(outs) - 3}" if len(outs) > 3 else ""))
            if gtd:
                parts.append("GTD " + ", ".join(n for _, n in gtd[:2]))
            lines.append(f"🩹 {ab(t)}: " + " · ".join(parts))
        return lines

    def soon_msg(t, a, h, when, mins, cupg, a_ml, h_ml, day, eid=None):
        o = owner.get(t)
        opp_ = h if t == a else a
        where = "vs" if t == h else "@"
        m = max(5, int(round(mins / 5.0)) * 5)
        title = f"⏰ {short(t)} tip off in {m} min" if short(t).endswith("s") else f"⏰ {short(t)} tips off in {m} min"
        lines = [f"🏀 {ab(t)} {where} {ab(opp_)} · {when} PT"]
        mine = h_ml if t == h else a_ml
        if mine is not None:
            try:
                v = int(float(mine)); lines.append(f"💵 {ab(t)} {'+' if v > 0 else '−'}{abs(v)} " + ("favorite" if v < 0 else "underdog"))
            except (TypeError, ValueError):
                pass
        if cupg:
            lines.append(f"🏆 NBA Cup: a win counts {cup_win}")
        opp_t = h if t == a else a
        lines += injury_report(eid, [t, opp_t])
        wl = week_line(o, day)
        if wl:
            lines.append(wl)
        return title, "\n".join(lines)

    # 1. finals for your teams (only last night / today, so old games never fire)
    for g in games:
        if g["date"] < cutoff or g.get("home_score") is None:
            continue
        msgs = [m_ for m_ in final_msgs(g) if f"final|{g['id']}|{m_[0]}" not in sent_ids]
        if not msgs:
            continue
        box = box_lines(summary(g["id"], log)) if key else {}
        for o, t_, b_ in msgs:
            stars = []
            for tm in (g["away"], g["home"]):
                if owner.get(tm) == o and box.get(tm):
                    p_ = max(box[tm], key=lambda r: (r["pts"], r["reb"] + r["ast"]))
                    stars.append(f"⭐ {nm(p_['name'])} ({ab(tm)}): {stat_line(p_)}")
            if stars:
                first, *rest = b_.split("\n")
                b_ = "\n".join([first] + stars + rest)
            once(f"final|{g['id']}|{o}", o, t_, b_)

    # 2. starting soon
    for e in events:
        if e.get("state") != "pre" or e["date"] != today.isoformat():
            continue
        mins = (e["start"] - now_utc).total_seconds() / 60
        if not (0 < mins <= SOON_MIN):
            continue
        a, h = e["away"]["name"], e["home"]["name"]
        od = e.get("odds") or {}
        for t in (a, h):
            o = owner.get(t)
            if not o:
                continue
            if f"soon|{e['id']}|{o}" in sent_ids:
                continue
            t_, b_ = soon_msg(t, a, h, e["time"], mins, "nba cup" in (e.get("notes") or "").lower(), od.get("away_ml"), od.get("home_ml"), today, e["id"])
            once(f"soon|{e['id']}|{o}", o, t_, b_)

    # test: one of each alert type for this owner, built from real games
    if test_to and os.environ.get("PUSH_TEST_KIND", "").strip() == "samples":
        mine_g = [g for g in games if test_to in (owner.get(g["home"]), owner.get(g["away"]))]
        if mine_g:
            g = mine_g[-1]
            for o, t_, b_ in final_msgs(g):
                if o == test_to:
                    send(app_id, key, o, t_ + " (test)", b_, log, count)
        for g in reversed(games):   # a real upset from this season
            w = g["home"] if g["home_score"] > g["away_score"] else g["away"]
            if upset_label(g, w) and owner.get(w):
                gg = dict(g)
                for o, t_, b_ in final_msgs(gg):
                    if o == owner.get(w):
                        send(app_id, key, test_to, t_ + " (test)", b_.split("\n📊")[0] + "\n" + "\n".join(ctx(test_to, date.fromisoformat(g["date"]))), log, count)
                break
        sched = (load("schedule.json", {}) or {}).get("games", [])
        nx = next((x for x in sched if test_to in (owner.get(x["home"]), owner.get(x["away"]))), None)
        if nx:
            t = nx["home"] if owner.get(nx["home"]) == test_to else nx["away"]
            t_, b_ = soon_msg(t, nx["away"], nx["home"], nx.get("time", ""), 30, bool(nx.get("cup")), nx.get("away_ml"), nx.get("home_ml"), date.fromisoformat(nx["date"]))
            send(app_id, key, test_to, t_ + " (test)", b_, log, count)

    # 3. nightly recap, once every game on today's slate is final
    recap_test = test_to if os.environ.get("PUSH_TEST_KIND", "").strip() == "recap" else ""
    real_today = today
    if recap_test:   # test: rebuild the most recent game day's recap
        today = date.fromisoformat(max(g["date"] for g in games))
    todays = [e for e in events if e["date"] == today.isoformat() and e.get("season_type") in (2, 3)]
    if recap_test or (todays and all(e.get("completed") for e in todays) and f"recap|{today.isoformat()}" not in plog.get("recaps", [])):
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
        won_t = {o: [] for o in owners}; lost_t = {o: [] for o in owners}
        for g in games:
            if g["date"] != today.isoformat():
                continue
            hw = g["home_score"] > g["away_score"]
            w, l = (g["home"], g["away"]) if hw else (g["away"], g["home"])
            if owner.get(w):
                tonight[owner[w]][0] += cup_win if g.get("cup") else win
                won_t[owner[w]].append(ab(w))
            if owner.get(l):
                tonight[owner[l]][1] += 1
                lost_t[owner[l]].append(ab(l))
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
        # yesterday's standings, to show movement
        prev_pts = {o: pts[o] - tonight[o][0] for o in owners}
        place_of = lambda o, P: 1 + sum(1 for x in owners if P[x] > P[o])
        for o in owners:
            w_pts, losses = tonight[o]
            if w_pts == 0 and losses == 0:
                continue   # no games tonight for this owner
            place, was = place_of(o, pts), place_of(o, prev_pts)
            tied = sum(1 for x in owners if pts[x] == pts[o]) > 1
            mood = "🔥" if w_pts >= 4 and not losses else "📈" if w_pts > losses else "🧊" if not w_pts else "🏀"
            title = f"{mood} Nightly recap: " + (f"+{w_pts} tonight" if w_pts else "no wins tonight")
            lines = []
            res = []
            if won_t[o]:
                res.append("✅ " + ", ".join(won_t[o]))
            if lost_t[o]:
                res.append("❌ " + ", ".join(lost_t[o]))
            lines.append("   ".join(res))
            move = " ▲ up from " + ordn(was) if place < was else " ▼ down from " + ordn(was) if place > was else ""
            lead = pts[order[0]] - pts[o]
            gap = (" · " + (f"{lead} back of 1st" if lead else ("tied for 1st" if tied else f"{pts[o] - max(pts[x] for x in owners if x != o)} ahead")))
            lines.append(f"📊 {pts[o]} pts, {'T-' if tied else ''}{ordn(place)} of {len(owners)}{move}{gap if not move else ''}")
            if o in opp:
                p = opp[o]
                d = net[o] - net[p]
                state = f"up {d}" if d > 0 else f"down {abs(d)}" if d < 0 else "all square"
                lines.append(f"⚔️ Week {wk} vs {p}: {state} ({sign(net[o])} to {sign(net[p])})")
            if recap_test:
                if o == recap_test:
                    send(app_id, key, o, title + " (test)", "\n".join(lines), log, count)
                continue
            once(f"recap|{today.isoformat()}|{o}", o, title, "\n".join(lines))
        if not recap_test:
            plog.setdefault("recaps", []).append(f"recap|{today.isoformat()}")
    today = real_today

    # ---------- more alerts: matchups, standings, playoffs, close games, injuries, game-day lineup, weekly awards ----------
    local = now_utc.astimezone(pt)
    test_more = test_to if os.environ.get("PUSH_TEST_KIND", "").strip() == "more" else ""
    st = plog.setdefault("state", {})
    first_time = not st.get("init")
    M = cfg.get("matchups") or {}
    week1 = date.fromisoformat(cfg["week1_monday"])
    def wk_of(d):
        return (d - week1).days // 7 + 1
    def pairs(wk):
        if not M.get("rounds") or wk < M.get("start_week", 1):
            return []
        return M["rounds"][(wk - M.get("start_week", 1)) % len(M["rounds"])]
    def week_nets(wk, through):
        start = week1 + timedelta(days=(wk - 1) * 7); end = min(start + timedelta(days=6), through)
        net = {o: 0 for o in owners}; wins = {o: 0 for o in owners}; losses = {o: 0 for o in owners}
        for g in games:
            d = date.fromisoformat(g["date"])
            if not (start <= d <= end):
                continue
            hw = g["home_score"] > g["away_score"]
            w, l = (g["home"], g["away"]) if hw else (g["away"], g["home"])
            wt = 2 if g.get("cup") else 1
            if owner.get(w): net[owner[w]] += wt; wins[owner[w]] += 1
            if owner.get(l): net[owner[l]] -= wt; losses[owner[l]] += 1
        return net, wins, losses
    def leader(a, b, net, wins):
        if net[a] != net[b]: return a if net[a] > net[b] else b
        if wins[a] != wins[b]: return a if wins[a] > wins[b] else b
        return None
    def deliver(eid, o, title, body):
        if test_more:
            if o == test_more and eid.split("|")[0] not in sent_kinds:
                sent_kinds.add(eid.split("|")[0]); send(app_id, key, o, title + " (test)", body, log, count)
            return
        if not first_time:
            once(eid, o, title, body)
        else:
            sent_ids[eid] = today.isoformat()
    sent_kinds = set()
    wk_now = wk_of(today)

    # 1. matchup lead changes (this week)
    net, wins, _ = week_nets(wk_now, today)
    leads = st.setdefault("leads", {})
    for a, b in pairs(wk_now):
        k = f"{wk_now}|{a}|{b}"; ld = leader(a, b, net, wins); was = leads.get(k, "?")
        if test_more and test_more in (a, b):
            was = b if ld == a else a   # pretend it just flipped
        if was != "?" and ld and ld != was:
            for o in (a, b):
                other = b if o == a else a
                if ld == o:
                    deliver(f"lead|{k}|{ld}|{today}", o, f"🔄 You took the lead on {other}!", f"⚔️ Week {wk_now}: up {abs(net[o]-net[other]) or 'on total wins'} ({sign(net[o])} to {sign(net[other])})\n" + pts_line(o))
                else:
                    deliver(f"lead|{k}|{ld}|{today}", o, f"⚠️ {other} took the lead", f"⚔️ Week {wk_now}: down {abs(net[o]-net[other]) or 'on total wins'} ({sign(net[o])} to {sign(net[other])})\n" + pts_line(o))
        leads[k] = ld

    # 2 + 3 + 9. Monday morning: last week's results, weekly awards, this week's preview
    if (local.weekday() == 0 and local.hour >= 9) or test_more:
        last = wk_now - 1
        if last >= M.get("start_week", 1):
            n2, w2, l2 = week_nets(last, week1 + timedelta(days=(last - 1) * 7 + 6))
            rec = {o: [0, 0, 0] for o in owners}
            for wk in range(M.get("start_week", 1), last + 1):
                nn, ww, _ = week_nets(wk, week1 + timedelta(days=(wk - 1) * 7 + 6))
                for a, b in pairs(wk):
                    L_ = leader(a, b, nn, ww)
                    for o in (a, b):
                        rec[o][0 if L_ == o else 2 if L_ is None else 1] += 1
            for a, b in pairs(last):
                L_ = leader(a, b, n2, w2)
                for o in (a, b):
                    other = b if o == a else a
                    r = rec[o]; rs = f"{r[0]}–{r[1]}" + (f"–{r[2]}" if r[2] else "")
                    t_ = f"🏁 You beat {other} in Week {last}!" if L_ == o else f"🏁 {other} won Week {last}" if L_ else f"🏁 Week {last} vs {other}: a tie"
                    deliver(f"wkres|{last}|{o}", o, t_, f"⚔️ Final: {sign(n2[o])} to {sign(n2[other])} ({w2[o]}–{l2[o]} vs {w2[other]}–{l2[other]})\n📋 Matchup record: {rs}")
            best = max(w2.values()); worst = min(n2.values())
            kings = [o for o in owners if w2[o] == best]; colds = [o for o in owners if n2[o] == worst]
            body = f"👑 Most wins: {' & '.join(kings)} ({best})\n🧊 Coldest week: {' & '.join(colds)} ({sign(worst)} net)"
            for o in owners:
                deliver(f"awards|{last}|{o}", o, f"🏅 Week {last} awards", body)
        sched = (load("season_schedule.json", {}) or {}).get("games", []) + (load("schedule.json", {}) or {}).get("games", [])
        start = week1 + timedelta(days=(wk_now - 1) * 7); end = start + timedelta(days=6)
        seen = set(); cnt = {o: 0 for o in owners}; cupc = {o: 0 for o in owners}
        for g in games + sched:
            d = date.fromisoformat(g["date"]); k = (g["date"], g["away"], g["home"])
            if not (start <= d <= end) or k in seen:
                continue
            seen.add(k)
            for t in (g["away"], g["home"]):
                if owner.get(t): cnt[owner[t]] += 1; cupc[owner[t]] += 1 if g.get("cup") else 0
        for a, b in pairs(wk_now):
            for o in (a, b):
                other = b if o == a else a
                lines = [f"📅 You have {cnt[o]} games, {other} has {cnt[other]}"]
                if cupc[o] or cupc[other]:
                    lines.append(f"🏆 Cup games (±2): you {cupc[o]}, {other} {cupc[other]}")
                lines.append(pts_line(o))
                deliver(f"preview|{wk_now}|{o}", o, f"⚔️ Week {wk_now}: you vs {other}", "\n".join(lines))

    # 4. standings moves
    places = st.setdefault("places", {})
    for o in owners:
        pl = 1 + sum(1 for x in owners if PTS[x] > PTS[o]); was = places.get(o)
        if test_more == o and was is None:
            was = pl + 1
        if was and pl != was:
            top = max(PTS.values()); gap = top - PTS[o]
            nxt = sorted((PTS[x] for x in owners if PTS[x] > PTS[o]))
            tail = (f"🎯 {gap} back of 1st" if gap else "🎯 You're in 1st")
            if pl < was:
                deliver(f"move|{o}|{pl}|{today}", o, f"📈 You moved up to {ordn(pl)}!", f"{pts_line(o)}\n{tail}")
            else:
                chaser = [x for x in owners if x != o and PTS[x] > PTS[o]]
                who = min(chaser, key=lambda x: PTS[x]) if chaser else None
                deliver(f"move|{o}|{pl}|{today}", o, f"📉 You slipped to {ordn(pl)}", f"{pts_line(o)}\n" + (f"🎯 {PTS[who] - PTS[o]} behind {who}" if who else tail))
        places[o] = pl

    # 5. playoff odds milestones (crossing 99% or dropping under 5%)
    od = (load("odds.json", {}) or {}).get("teams", {})
    marks = st.setdefault("odds", {})
    for t, v in od.items():
        o = owner.get(t); pc = v.get("playoffs")
        if not o or pc is None:
            continue
        band = "lock" if pc >= 99 else "out" if pc < 5 else "mid"; was = marks.get(t)
        if test_more == o and band != "mid" and was is None:
            was = "mid"
        if was and band != was and band != "mid":
            if band == "lock":
                deliver(f"odds|{t}|lock", o, f"🎟️ {short(t)} are a playoff lock", f"📈 Playoff odds: {pc:.0f}%+\n💰 Making the playoffs is worth +{S.get('made_playoffs', 5)}\n" + pts_line(o))
            else:
                deliver(f"odds|{t}|out", o, f"📉 {short(t)} playoff hopes fading", f"📉 Playoff odds: under 5%\n" + pts_line(o))
        marks[t] = band
    for bb in bonuses:   # actual clinch, once the playoffs are set
        o = owner.get(bb["team"])
        if o and bb.get("made_playoffs"):
            deliver(f"clinch|{bb['team']}", o, f"🎟️ {short(bb['team'])} made the playoffs! +{S.get('made_playoffs', 5)}", pts_line(o))

    # 6. close game late (4th quarter or OT, within 5)
    for e in events:
        if e.get("state") != "in":
            continue
        det = (e.get("detail") or "")
        if not ("4th" in det or "OT" in det):
            continue
        a, h = e["away"], e["home"]
        if a.get("score") is None or h.get("score") is None or abs(a["score"] - h["score"]) > 5:
            continue
        for t in (a["name"], h["name"]):
            o = owner.get(t)
            if o:
                deliver(f"close|{e['id']}|{o}", o, f"🔥 Close one: {short(t)} game is tight", f"🏀 {ab(a['name'])} {a['score']}, {ab(h['name'])} {h['score']} · {det}\n" + (week_line(o, today) or pts_line(o)))
    if test_more:   # a sample close game for the test
        gg = next((g for g in reversed(games) if test_more in (owner.get(g["home"]), owner.get(g["away"]))), None)
        if gg:
            t = gg["home"] if owner.get(gg["home"]) == test_more else gg["away"]
            deliver(f"close|test|{test_more}", test_more, f"🔥 Close one: {short(t)} game is tight", f"🏀 {ab(gg['away'])} 101, {ab(gg['home'])} 99 · 2:14 - 4th\n" + (week_line(test_more, today) or pts_line(test_more)))

    # 6b. overtime
    for e in events:
        if e.get("state") == "in" and "OT" in (e.get("detail") or ""):
            a, h = e["away"], e["home"]
            for t in {a["name"], h["name"]}:
                o = owner.get(t)
                if o:
                    deliver(f"ot|{e['id']}|{o}", o, f"⏱️ Overtime! {short(t)} game is going extra", f"🏀 {ab(a['name'])} {a['score']}, {ab(h['name'])} {h['score']} · {e.get('detail')}\n" + (week_line(o, today) or pts_line(o)))

    # 6c. players going off on your teams: 30 / 40 / 50 points, or a triple-double (live games)
    HOT = [(50, "50"), (40, "40"), (30, "30")]
    for e in events:
        if e.get("state") != "in":
            continue
        a, h = e["away"], e["home"]
        mine_t = [t for t in (a["name"], h["name"]) if owner.get(t)]
        if not mine_t or not key:
            continue
        box = box_lines(summary(e["id"], log))
        for t in mine_t:
            o = owner.get(t)
            for p_ in box.get(t, []):
                lvl = next((tag for th, tag in HOT if p_["pts"] >= th), None)
                td = p_["pts"] >= 10 and p_["reb"] >= 10 and p_["ast"] >= 10
                score = f"🏀 {ab(a['name'])} {a['score']}, {ab(h['name'])} {h['score']} · {e.get('detail')}"
                if lvl:
                    eid = f"hot|{e['id']}|{p_['id']}|{lvl}"
                    if eid not in sent_ids:
                        for th, tag in HOT:   # mark lower levels too, so a 42 never also sends "30"
                            if p_["pts"] >= th:
                                sent_ids.setdefault(f"hot|{e['id']}|{p_['id']}|{tag}", today.isoformat()) if tag != lvl else None
                        deliver(eid, o, f"🔥 {p_['name']} has {p_['pts']} pts", f"📊 {stat_line(p_)}\n{score}")
                if td:
                    deliver(f"hot|{e['id']}|{p_['id']}|td", o, f"🔥 {p_['name']} has a triple-double", f"📊 {stat_line(p_)}\n{score}")

    # 7. injury news on key players (Out / Doubtful), once per player per status
    try:
        import odds as _odds
        imp = _odds.player_impact
    except Exception:
        imp = lambda p_: 0
    inj = (load("injuries.json", {}) or {}).get("players", [])
    seen_inj = st.setdefault("inj", {})
    for p_ in sorted(inj, key=lambda x: -imp(x)):
        o = owner.get(p_.get("team")); stt = (p_.get("status") or "")
        if not o or imp(p_) < 2 or not (stt.lower().startswith("out") or "doubtful" in stt.lower()):
            continue
        kk = f"{p_.get('id')}|{stt}"
        if seen_inj.get(p_.get("id")) == stt and not test_more:
            continue
        seen_inj[p_.get("id")] = stt
        sts = p_.get("stats") or {}
        ret = f"\n🗓️ Expected back: {date.fromisoformat(p_['return'][:10]).strftime('%b %-d')}" if p_.get("return") else ""
        deliver(f"inj|{kk}", o, f"🩹 {p_['name']} ({ab(p_['team'])}): {stt}", "📋 " + (lambda c: c if len(c) <= 110 else c[:107].rsplit(" ", 1)[0] + "…")((p_.get('comment') or '').strip()) + (f"\n📊 {sts.get('pts', 0):.1f} pts · {sts.get('reb', 0):.1f} reb · {sts.get('ast', 0):.1f} ast" if sts else "") + ret)

    # 8. morning game-day lineup (first run after 9 AM PT)
    started = any(e.get("state") != "pre" for e in events if e.get("date") == today.isoformat())
    if (local.hour >= 9 and not started) or test_more:
        sched_t = [g for g in ((load("schedule.json", {}) or {}).get("games", [])) if g["date"] == today.isoformat()]
        if test_more and not any(test_more in (owner.get(g["home"]), owner.get(g["away"])) for g in sched_t):
            nxt = [g for g in ((load("schedule.json", {}) or {}).get("games", [])) if g["date"] > today.isoformat()]
            if nxt:
                sched_t = [g for g in nxt if g["date"] == nxt[0]["date"]]
        for o in owners:
            mine = []
            for g in sched_t:
                ts = [t for t in (g["away"], g["home"]) if owner.get(t) == o]
                if not ts:
                    continue
                if len(ts) == 2:
                    mine.append(f"🏀 {ab(g['away'])} @ {ab(g['home'])} · {g.get('time', '')} · both yours" + (" 🏆" if g.get("cup") else ""))
                    continue
                t = ts[0]; where = "vs" if t == g["home"] else "@"; oth = g["away"] if t == g["home"] else g["home"]
                mine.append(f"🏀 {ab(t)} {where} {ab(oth)} · {g.get('time', '')}" + (" 🏆" if g.get("cup") else ""))
            if mine:
                deliver(f"lineup|{today}|{o}", o, f"📅 Game day: {len(mine)} game{'s' if len(mine) != 1 else ''} today", "\n".join(mine[:5]))

    if test_to and os.environ.get("PUSH_TEST_KIND", "").strip() == "new":
        # tip-off with injury report, from this owner's next game today/tomorrow
        nx = next((e for e in sorted(events, key=lambda e: e["start"]) if e.get("state") == "pre" and test_to in (owner.get(e["away"]["name"]), owner.get(e["home"]["name"]))), None)
        if nx:
            a, h = nx["away"]["name"], nx["home"]["name"]; t = a if owner.get(a) == test_to else h
            od = nx.get("odds") or {}
            t_, b_ = soon_msg(t, a, h, nx["time"], 30, "nba cup" in (nx.get("notes") or "").lower(), od.get("away_ml"), od.get("home_ml"), date.fromisoformat(nx["date"]), nx["id"])
            send(app_id, key, test_to, t_ + " (test)", b_, log, count)
        # a big game, from this owner's most recent final
        gg = next((g for g in reversed(games) if test_to in (owner.get(g["home"]), owner.get(g["away"]))), None)
        if gg:
            box = box_lines(summary(gg["id"], log))
            t = gg["home"] if owner.get(gg["home"]) == test_to else gg["away"]
            if box.get(t):
                p_ = max(box[t], key=lambda r: (r["pts"], r["reb"] + r["ast"]))
                send(app_id, key, test_to, f"🔥 {p_['name']} has {p_['pts']} pts (test)", f"📊 {stat_line(p_)}\n🏀 {ab(gg['away'])} {gg['away_score']}, {ab(gg['home'])} {gg['home_score']} · 4:12 - 4th", log, count)
            send(app_id, key, test_to, f"⏱️ Overtime! {short(t)} game is going extra (test)", f"🏀 {ab(gg['away'])} 112, {ab(gg['home'])} 112 · 5:00 - OT\n" + (week_line(test_to, today) or pts_line(test_to)), log, count)
            for o, t_, b_ in final_msgs(gg):   # final with the star line
                if o == test_to and box.get(t):
                    p_ = max(box[t], key=lambda r: (r["pts"], r["reb"] + r["ast"]))
                    first, *rest = b_.split("\n")
                    send(app_id, key, o, t_ + " (test)", "\n".join([first, f"⭐ {nm(p_['name'])} ({ab(t)}): {stat_line(p_)}"] + rest), log, count)
                    break

    if not test_more:
        st["init"] = True
    # forget old ids so the log stays small
    keep = (today - timedelta(days=KEEP_DAYS)).isoformat()
    plog["sent"] = {k: v for k, v in sent_ids.items() if v >= keep}
    plog["recaps"] = [r for r in plog.get("recaps", []) if r.split("|")[1] >= keep]
    save("push_log.json", plog)
    if count[0]:
        log.append(f"push: sent {count[0]} notification(s)")
