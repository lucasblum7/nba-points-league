/* NBA Points League — renders the league from the JSON files in /data.
   The GitHub Action refreshes those files every 15 minutes; while games are on,
   the page also asks ESPN for live scores directly every minute. */
(() => {
  'use strict';

  const TEAM_BADGE = {
    'Atlanta Hawks': ['ATL', '#E03A3E', '#FFFFFF'], 'Boston Celtics': ['BOS', '#007A33', '#FFFFFF'],
    'Brooklyn Nets': ['BKN', '#000000', '#FFFFFF'], 'Charlotte Hornets': ['CHA', '#1D1160', '#00A3AD'],
    'Chicago Bulls': ['CHI', '#CE1141', '#FFFFFF'], 'Cleveland Cavaliers': ['CLE', '#860038', '#FDBB30'],
    'Dallas Mavericks': ['DAL', '#00538C', '#FFFFFF'], 'Denver Nuggets': ['DEN', '#0E2240', '#FEC524'],
    'Detroit Pistons': ['DET', '#C8102E', '#FFFFFF'], 'Golden State Warriors': ['GSW', '#1D428A', '#FFC72C'],
    'Houston Rockets': ['HOU', '#CE1141', '#FFFFFF'], 'Indiana Pacers': ['IND', '#002D62', '#FDBB30'],
    'LA Clippers': ['LAC', '#1D428A', '#FFFFFF'], 'Los Angeles Lakers': ['LAL', '#552583', '#FDB927'],
    'Memphis Grizzlies': ['MEM', '#5D76A9', '#FFFFFF'], 'Miami Heat': ['MIA', '#98002E', '#F9A01B'],
    'Milwaukee Bucks': ['MIL', '#00471B', '#EEE1C6'], 'Minnesota Timberwolves': ['MIN', '#0C2340', '#78BE20'],
    'New Orleans Pelicans': ['NOP', '#0C2340', '#C8A464'], 'New York Knicks': ['NYK', '#006BB6', '#F58426'],
    'Oklahoma City Thunder': ['OKC', '#007AC1', '#FFFFFF'], 'Orlando Magic': ['ORL', '#0077C0', '#FFFFFF'],
    'Philadelphia 76ers': ['PHI', '#006BB6', '#FFFFFF'], 'Phoenix Suns': ['PHX', '#1D1160', '#E56020'],
    'Portland Trail Blazers': ['POR', '#E03A3E', '#FFFFFF'], 'Sacramento Kings': ['SAC', '#5A2D81', '#FFFFFF'],
    'San Antonio Spurs': ['SAS', '#C4CED4', '#000000'], 'Toronto Raptors': ['TOR', '#CE1141', '#FFFFFF'],
    'Utah Jazz': ['UTA', '#002B5C', '#F9A01B'], 'Washington Wizards': ['WAS', '#002B5C', '#FFFFFF'],
  };
  const ESPN_FIX = { 'Los Angeles Clippers': 'LA Clippers' };

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const short = (t) => (t.endsWith('Trail Blazers') ? 'Trail Blazers' : t.split(' ').slice(-1)[0]);
  const DAY = 864e5;
  const utc = (iso) => Date.parse(iso + 'T00:00:00Z');
  const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const dayName = (iso, opts) => new Date(utc(iso)).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
  const fmtDay = (iso) => dayName(iso, { weekday: 'short', month: 'short', day: 'numeric' });
  const pacificToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const ml = (v) => (v == null || isNaN(v) ? '' : v > 0 ? '+' + v : '−' + Math.abs(v));
  const badge = (team, cls) => {
    const b = TEAM_BADGE[team];
    const s = mk('span', cls, b ? b[0] : short(team));
    if (b) { s.style.background = b[1]; s.style.color = b[2]; }
    s.title = team;
    return s;
  };

  async function getJSON(path) {
    const r = await fetch(path + '?v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return r.json();
  }

  // ---------- league math ----------
  function compute(D) {
    const { rosters, projections, games, lines, bonuses, config } = D;
    const owner = new Map(rosters.map((r) => [r.team, r.owner]));
    const owners = [...new Set(rosters.map((r) => r.owner))];
    const proj = new Map(projections.map((p) => [p.team, Number(p.projected_wins)]));
    const bon = new Map(bonuses.map((b) => [b.team, b]));
    const S = config.scoring;
    const week1 = utc(config.week1_monday);
    const weekOf = (iso) => Math.floor((utc(iso) - week1) / DAY / 7) + 1;
    const sorted = games.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // per-team log of results
    const log = new Map(rosters.map((r) => [r.team, []]));
    for (const g of sorted) {
      const homeWon = g.home_score > g.away_score;
      if (log.has(g.home)) log.get(g.home).push({ date: g.date, opp: g.away, home: true, w: homeWon, cup: !!g.cup, score: `${g.home_score}-${g.away_score}` });
      if (log.has(g.away)) log.get(g.away).push({ date: g.date, opp: g.home, home: false, w: !homeWon, cup: !!g.cup, score: `${g.away_score}-${g.home_score}` });
    }

    const teams = rosters.map((r) => {
      const L = log.get(r.team) || [];
      const w = L.filter((x) => x.w).length, l = L.length - w;
      const b = bon.get(r.team) || {};
      const pts_playoffs = b.made_playoffs ? S.made_playoffs : 0;
      const pts_pw = (Number(b.playoff_wins) || 0) * S.playoff_win;
      const pts_cup = b.won_cup ? S.won_cup : 0;
      const cup_wins = L.filter((x) => x.w && x.cup).length;
      const pts_cupgames = cup_wins * ((S.cup_game_win ?? S.win) - S.win);   // extra point for each NBA Cup game win
      const pre = proj.get(r.team);
      const g = w + l;
      const rate = (w + 20 * (pre / 82)) / (g + 20);
      const pace = pre == null ? null : Math.round((w + (82 - g) * rate) * 10) / 10;
      const bonus = pts_playoffs + pts_pw + pts_cup + pts_cupgames;
      return { team: r.team, owner: r.owner, wins: w, losses: l, proj: pre, pace, last5: L.slice(-5).map((x) => (x.w ? 'W' : 'L')), last3: L.slice(-3),
        made: b.made_playoffs ? 1 : 0, playoff_wins: Number(b.playoff_wins) || 0, pts_playoffs, pts_pw, pts_cup, cup_wins, pts_cupgames, bonus,
        series: Number(b.series_won) || 0, points: w + bonus };
    });

    // weekly wins per owner
    const lastDate = sorted.length ? sorted[sorted.length - 1].date : config.season_start;
    const curWeek = Math.max(1, weekOf(pacificToday() > lastDate ? pacificToday() : lastDate));
    const weekly = [];
    for (let wk = 1; wk <= curWeek; wk++) {
      const tot = Object.fromEntries(owners.map((o) => [o, 0]));
      const loss = Object.fromEntries(owners.map((o) => [o, 0]));
      for (const g of sorted) {
        if (weekOf(g.date) !== wk) continue;
        const homeWon = g.home_score > g.away_score;
        const winner = homeWon ? g.home : g.away, loser = homeWon ? g.away : g.home;
        if (owner.has(winner)) tot[owner.get(winner)]++;
        if (owner.has(loser)) loss[owner.get(loser)]++;
      }
      const best = Math.max(...Object.values(tot));
      const start = isoOf(week1 + (wk - 1) * 7 * DAY), end = isoOf(week1 + ((wk - 1) * 7 + 6) * DAY);
      weekly.push({ week: wk, start, end, tot, loss, best, winners: best > 0 ? owners.filter((o) => tot[o] === best) : [],
        current: wk === curWeek, done: pacificToday() > end });
    }

    // head-to-head matchups: net record (W − L) wins the week, most wins breaks a tie
    const M = config.matchups;
    const matchups = [];
    const h2h = Object.fromEntries(owners.map((o) => [o, { owner: o, w: 0, l: 0, t: 0, net: 0, wins: 0 }]));
    if (M) {
      const lastWeek = Math.max(curWeek, M.start_week);  // through the current week only
      for (let wk = M.start_week; wk <= lastWeek; wk++) {
        const round = M.rounds[(wk - M.start_week) % M.rounds.length];
        const info = weekly[wk - 1];
        const start = isoOf(week1 + (wk - 1) * 7 * DAY), end = isoOf(week1 + ((wk - 1) * 7 + 6) * DAY);
        const status = !info ? 'upcoming' : info.done ? 'final' : 'live';
        round.forEach(([a, b]) => {
          const side = (o) => {
            const w = info ? info.tot[o] : 0, l = info ? info.loss[o] : 0;
            return { owner: o, w, l, net: w - l };
          };
          const A = side(a), B = side(b);
          let winner = null;
          if (info && (A.w + A.l + B.w + B.l) > 0) {
            if (A.net !== B.net) winner = A.net > B.net ? a : b;
            else if (A.w !== B.w) winner = A.w > B.w ? a : b;
          }
          matchups.push({ week: wk, start, end, status, A, B, winner });
          if (status === 'final') {
            for (const [me, them] of [[A, B], [B, A]]) {
              const r = h2h[me.owner];
              r.net += me.net; r.wins += me.w;
              if (!winner) r.t++; else if (winner === me.owner) r.w++; else r.l++;
            }
          }
        });
      }
    }
    const h2hTable = Object.values(h2h).sort((x, y) => (y.w + y.t / 2) - (x.w + x.t / 2) || y.net - x.net || y.wins - x.wins || x.owner.localeCompare(y.owner));

    const board = owners.map((o) => {
      const mine = teams.filter((t) => t.owner === o);
      const sum = (k) => mine.reduce((a, t) => a + (t[k] || 0), 0);
      return { owner: o, wins: sum('wins'), bonus: sum('bonus'), points: sum('points'), series: sum('series'),
        proj: Math.round(sum('proj') * 10) / 10, pace: Math.round(sum('pace') * 10) / 10,
        this_week: weekly.length ? weekly[weekly.length - 1].tot[o] : 0,
        weeks_won: weekly.filter((w) => !w.current && w.winners.includes(o)).length };
    }).sort((a, b) => b.points - a.points || b.series - a.series || b.wins - a.wins);
    board.forEach((b, i) => { b.rank = i + 1; b.place = 1 + board.filter((x) => x.points > b.points).length; b.behind = board[0].points - b.points; });

    // upsets
    const tiers = config.upset_tiers.slice().sort((a, b) => b.min - a.min);
    const lineOf = new Map(lines.map((l) => [l.date + '|' + l.away + '|' + l.home, l]));
    const upsets = [];
    for (const g of sorted) {
      const ln = lineOf.get(g.date + '|' + g.away + '|' + g.home);
      if (!ln) continue;
      const awayWon = g.away_score > g.home_score;
      const winner = awayWon ? g.away : g.home, loser = awayWon ? g.home : g.away;
      const price = Number(awayWon ? ln.away_ml : ln.home_ml);
      const tier = tiers.find((t) => price >= t.min);
      if (!tier) continue;
      upsets.push({ date: g.date, team: winner, owner: owner.get(winner) || '', opp: loser, ml: price, tier: tier.label, pts: tier.pts,
        score: awayWon ? `${g.away_score}-${g.home_score}` : `${g.home_score}-${g.away_score}` });
    }
    upsets.sort((a, b) => (a.date < b.date ? 1 : -1) || b.ml - a.ml);

    return { owner, owners, teams, board, weekly, upsets, log, lineOf, sorted, matchups, h2hTable, curWeek };
  }

  // ---------- live scores (straight from ESPN, if the browser allows it) ----------
  async function liveSlate(date) {
    try {
      const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=' + date.replace(/-/g, ''), { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      return (j.events || []).map((ev) => {
        const c = (ev.competitions || [{}])[0];
        const st = (c.status || ev.status || {}).type || {};
        const side = (ha) => c.competitors.find((x) => x.homeAway === ha);
        const nm = (x) => ESPN_FIX[x.team.displayName] || x.team.displayName;
        const h = side('home'), a = side('away');
        const notes = (c.notes || []).map((n) => n.headline || '').join(' ').toLowerCase();
        return { id: String(ev.id), state: st.state, detail: st.shortDetail || '', season_type: (ev.season || {}).type,
          cup: notes.includes('nba cup') && !notes.includes('championship'),
          time: new Date(ev.date).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }),
          away: nm(a), home: nm(h), away_score: st.state === 'pre' ? null : Number(a.score), home_score: st.state === 'pre' ? null : Number(h.score) };
      });
    } catch (e) { return null; }
  }

  // ---------- player roster dropdown (click a team name) ----------
  const ESPN_ID = {   // ESPN team ids, for the click-to-show player roster
    'Atlanta Hawks': 1, 'Boston Celtics': 2, 'New Orleans Pelicans': 3, 'Chicago Bulls': 4,
    'Cleveland Cavaliers': 5, 'Dallas Mavericks': 6, 'Denver Nuggets': 7, 'Detroit Pistons': 8,
    'Golden State Warriors': 9, 'Houston Rockets': 10, 'Indiana Pacers': 11, 'LA Clippers': 12,
    'Los Angeles Lakers': 13, 'Miami Heat': 14, 'Milwaukee Bucks': 15, 'Minnesota Timberwolves': 16,
    'Brooklyn Nets': 17, 'New York Knicks': 18, 'Orlando Magic': 19, 'Philadelphia 76ers': 20,
    'Phoenix Suns': 21, 'Portland Trail Blazers': 22, 'Sacramento Kings': 23, 'San Antonio Spurs': 24,
    'Oklahoma City Thunder': 25, 'Utah Jazz': 26, 'Washington Wizards': 27, 'Toronto Raptors': 28,
    'Memphis Grizzlies': 29, 'Charlotte Hornets': 30,
  };
  const playerCache = new Map();
  const seasonYear = () => Number(((D.config && D.config.season_start) || '2026-10-20').slice(0, 4)) + 1;   // ESPN names a season by its end year
  const STAT_KEYS = ['gamesPlayed', 'avgMinutes', 'avgPoints', 'avgRebounds', 'avgAssists'];
  async function fetchPlayers(team) {
    if (playerCache.has(team)) return playerCache.get(team);
    const id = ESPN_ID[team], yr = seasonYear();
    const core = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/' + yr;
    const [ro, dc] = await Promise.all([
      fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${id}/roster`).then((r) => { if (!r.ok) throw new Error('roster ' + r.status); return r.json(); }),
      fetch(`${core}/teams/${id}/depthcharts`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    let list = ro.athletes || [];
    if (list.length && Array.isArray(list[0].items)) list = list.flatMap((g) => g.items);
    // per-game stats, one request per player, all at once
    const stats = new Map();
    await Promise.all(list.map(async (a) => {
      try {
        const r = await fetch(`${core}/types/2/athletes/${a.id}/statistics`);
        if (!r.ok) return;
        const j = await r.json(); const f = {};
        for (const c of (j.splits && j.splits.categories) || []) for (const st of c.stats || []) if (STAT_KEYS.includes(st.name)) f[st.name] = st.displayValue;
        stats.set(String(a.id), f);
      } catch (e) { /* no stats yet for this player */ }
    }));
    // depth chart: best (lowest) rank for each player, and who starts at each spot
    const ORDER = ['pg', 'sg', 'sf', 'pf', 'c'];
    const best = new Map(); const byPos = {};
    const pos = (dc && dc.items && dc.items[0] && dc.items[0].positions) || {};
    for (const k of ORDER) {
      const ath = ((pos[k] && pos[k].athletes) || []).map((x) => ({ id: ((x.athlete && x.athlete.$ref) || '').match(/athletes\/(\d+)/), rank: x.rank }))
        .filter((x) => x.id).map((x) => ({ id: x.id[1], rank: x.rank })).sort((a, b) => a.rank - b.rank);
      byPos[k] = ath;
      ath.forEach((x) => { const b = best.get(x.id); if (!b || x.rank < b.rank) best.set(x.id, { rank: x.rank, pos: k }); });
    }
    const starters = new Map(); const used = new Set();
    for (const k of ORDER) { const pick = (byPos[k] || []).find((x) => !used.has(x.id)); if (pick) { used.add(pick.id); starters.set(pick.id, k); } }
    const players = list.map((a) => {
      const pid = String(a.id); const b = best.get(pid);
      return {
        id: pid, num: a.jersey ?? '', name: a.displayName || a.fullName || '',
        spot: starters.has(pid) ? starters.get(pid).toUpperCase() : (b ? b.pos.toUpperCase() : ((a.position && a.position.abbreviation) || '')),
        starter: starters.has(pid), order: starters.has(pid) ? ORDER.indexOf(starters.get(pid)) : (b ? 10 + b.rank * 5 + ORDER.indexOf(b.pos) : 999),
        out: (a.injuries && a.injuries.length) ? (a.injuries[0].status || 'Injured') : '', s: stats.get(pid) || null,
      };
    }).sort((x, y) => x.order - y.order || x.name.localeCompare(y.name));
    const res = { players, hasDepth: best.size > 0 };
    playerCache.set(team, res);
    return res;
  }
  function playersRow(team) {
    const tr = mk('tr', 'players-row'); const td = mk('td'); td.colSpan = 6; tr.append(td);
    const box = mk('div', 'players'); td.append(box);
    box.append(mk('p', 'players-msg', 'Loading roster…'));
    fetchPlayers(team).then(({ players: ps, hasDepth }) => {
      box.replaceChildren();
      if (!ps.length) { box.append(mk('p', 'players-msg', 'No roster found.')); return; }
      const t = mk('table', 'players-table'); const h = mk('tr');
      [['Pos', ''], ['Player', ''], ['GP', 'num'], ['MIN', 'num'], ['PTS', 'num'], ['REB', 'num'], ['AST', 'num']].forEach(([x, c]) => h.append(mk('th', c, x)));
      const th = mk('thead'); th.append(h); t.append(th);
      const section = (label, rows) => {
        if (!rows.length) return;
        const tb = mk('tbody'); const lr = mk('tr', 'pp-group'); const lc = mk('td', null, label); lc.colSpan = 7; lr.append(lc); tb.append(lr);
        rows.forEach((p) => {
          const r = mk('tr', p.starter ? 'pp-starter' : null);
          const nm = mk('td', 'pp-name'); const parts = p.name.split(' '); const short = parts.length > 1 ? parts[0][0] + '. ' + parts.slice(1).join(' ') : p.name;
          nm.append(mk('span', 'pp-num', p.num === '' ? '' : '#' + p.num), mk('span', 'pp-full', p.name), mk('span', 'pp-short', short));
          if (p.out) { const tag = mk('span', 'pp-out', /day/i.test(p.out) ? 'DTD' : p.out); tag.title = p.out; nm.append(tag); }
          const v = (k) => (p.s && p.s[k] != null ? p.s[k] : '–');
          r.append(mk('td', 'pp-pos', p.spot), nm, mk('td', 'num pp-dim', v('gamesPlayed')), mk('td', 'num pp-dim', v('avgMinutes')),
            mk('td', 'num pp-pts', v('avgPoints')), mk('td', 'num', v('avgRebounds')), mk('td', 'num', v('avgAssists')));
          tb.append(r);
        });
        t.append(tb);
      };
      if (hasDepth) { section('Starters', ps.filter((p) => p.starter)); section('Bench', ps.filter((p) => !p.starter)); }
      else section('Roster', ps);
      box.append(t, mk('p', 'players-foot', 'Season averages per game · Lineup from ESPN’s depth chart'));
    }).catch(() => { box.replaceChildren(mk('p', 'players-msg', 'Couldn’t load the roster right now. Try again in a minute.')); playerCache.delete(team); });
    return tr;
  }
  function makeExpandable(nameTd, team, anchorRow) {
    if (!ESPN_ID[team]) return;
    nameTd.classList.add('team-toggle'); nameTd.tabIndex = 0; nameTd.setAttribute('role', 'button'); nameTd.setAttribute('aria-expanded', 'false');
    nameTd.title = 'Show roster';
    let open = null;
    const toggle = () => {
      if (open) { open.remove(); open = null; nameTd.setAttribute('aria-expanded', 'false'); openRosters.delete(team); return; }
      open = playersRow(team); anchorRow().after(open); nameTd.setAttribute('aria-expanded', 'true'); openRosters.add(team);
    };
    nameTd.addEventListener('click', toggle);
    nameTd.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    if (openRosters.has(team)) { openRosters.delete(team); queueMicrotask(toggle); }   // stay open across the 1-minute refresh
  }
  const openRosters = new Set();

  // ---------- last 3 / next 3 strip under each roster team ----------
  const abbr = (team) => (TEAM_BADGE[team] || [short(team).slice(0, 3).toUpperCase()])[0];
  function nextGames(team, n) {
    const today = pacificToday();
    const played = new Set((D.games || []).map((g) => g.date + '|' + g.away + '|' + g.home));
    const started = new Set(((slate && slate.games) || []).filter((g) => g.state && g.state !== 'pre').map((g) => g.away + '|' + g.home));
    return ((D.schedule && D.schedule.games) || [])
      .filter((g) => (g.away === team || g.home === team) && g.date >= today && !played.has(g.date + '|' + g.away + '|' + g.home)
        && !(g.date === today && started.has(g.away + '|' + g.home)))
      .slice(0, n);
  }
  function schedRow(team, last3) {
    const tr = mk('tr', 'sched-row'); const td = mk('td'); td.colSpan = 6;
    const wrap = mk('div', 'sched');
    const past = mk('div', 'sched-side past');
    last3.forEach((x) => {
      const c = mk('span', 'gchip ' + (x.w ? 'win' : 'loss'));
      c.textContent = (x.home ? '' : '@') + abbr(x.opp);
      c.title = `${fmtDay(x.date)}: ${x.w ? 'Won' : 'Lost'} ${x.score} ${x.home ? 'vs' : 'at'} ${short(x.opp)}`;
      past.append(c);
    });
    for (let i = last3.length; i < 3; i++) past.prepend(mk('span', 'gchip empty', '–'));
    const next = mk('div', 'sched-side next');
    const up = nextGames(team, 3);
    up.forEach((g) => {
      const home = g.home === team, opp = home ? g.away : g.home;
      const c = mk('span', 'gchip up');
      const when = g.date === pacificToday() ? 'Today' : dayName(g.date, { weekday: 'short' });
      c.textContent = (home ? '' : '@') + abbr(opp);
      c.title = `${fmtDay(g.date)}${g.time ? ' ' + g.time : ''}: ${home ? 'vs' : 'at'} ${short(opp)}`;
      next.append(c);
    });
    for (let i = up.length; i < 3; i++) next.append(mk('span', 'gchip empty', '–'));
    wrap.append(past, mk('span', 'sched-div'), next);
    td.append(wrap); tr.append(td); return tr;
  }

  // ---------- rendering ----------
  // how many of an owner's teams play today, and how many are live right now
  function todayCount(owner, C, slate) {
    const gs = (slate && slate.games) || [];
    let total = 0, live = 0, done = 0;
    gs.forEach((g) => [g.away, g.home].forEach((t) => {
      if (C.owner.get(t) !== owner) return;
      total++; if (g.state === 'in') live++; else if (g.state === 'post') done++;
    }));
    return { total, live, done };
  }
  function todayPill(owner, C, slate) {
    const { total, live, done } = todayCount(owner, C, slate);
    const pill = mk('button', 'today-pill' + (live ? ' live' : total && done === total ? ' done' : !total ? ' none' : ''));
    pill.type = 'button'; pill.setAttribute('aria-label', `Show ${owner}'s games today`);
    pill.addEventListener('click', () => showToday(owner, C, slate));
    const two = (full, short) => { pill.append(mk('span', 'tp-full', full), mk('span', 'tp-short', short)); };
    if (live) { pill.append(mk('span', 'tp-dot', '●'), `${live} live`); if (total > live) pill.append(mk('span', 'tp-sub tp-full', ` · ${total} today`)); }
    else if (!total) two('No games today', 'Off today');
    else if (done === total) two(`${total} played today`, `${total} done`);
    else two(`🏀 ${total} ${total === 1 ? 'game' : 'games'} today`, `🏀 ${total} today`);
    return pill;
  }

  function render(D, C, slate) {
    const { board, teams, weekly, upsets, owner } = C;

    // takeaway
    const take = $('takeaway'); if (take) take.replaceChildren();
    if (take && board.length) {
      const [a, b] = board;
      take.append(mk('b', null, a.owner), ' leads with ', mk('b', null, fmt(a.points)), ' points');
      if (b) take.append(b.behind === 0 ? ', tied with ' + b.owner + '.' : ', ' + b.behind + ' ahead of ' + b.owner + '.');
    }

    // quick-stat chips
    const chips = $('chips');
    if (chips) {
      chips.replaceChildren();
      const chip = (icon, text, cls) => { const c = mk('span', 'chip' + (cls ? ' ' + cls : '')); c.append(mk('span', 'chip-i', icon), text); chips.append(c); };
      if (C.curWeek) chip('📅', 'Week ' + C.curWeek);
      const gs = (slate && slate.games) || [];
      const liveN = gs.filter((g) => g.state === 'in').length;
      if (liveN) chip('●', liveN + (liveN === 1 ? ' game' : ' games') + ' live', 'live');
      else if (gs.length) chip('🏀', gs.length + (gs.length === 1 ? ' game' : ' games') + ' today');
      else chip('🏀', 'No games today');
      const start = (D.config && D.config.season_start) || '2026-10-20';
      const day = Math.floor((new Date(pacificToday()) - new Date(start)) / 864e5) + 1;
      if (day > 0) chip('⏱', 'Day ' + day + ' of the season');
    }

    // leaderboard
    const lb = document.querySelector('#leaderboard tbody'); lb.replaceChildren();
    const max = Math.max(1, ...board.map((d) => d.points));
    board.forEach((d, i) => {
      const tr = mk('tr', d.points > 0 ? medal(d.place) : null);
      const bar = mk('div', 'bar');
      const w = mk('span'); w.style.width = (d.wins / max * 100) + '%';
      const bo = mk('span'); bo.style.width = (d.bonus / max * 100) + '%';
      bar.append(w, bo);
      const bc = mk('td', 'barcell hide-sm'); bc.append(bar);
      tr.append(mk('td', 'rank', d.rank), mk('td', 'total', d.owner), mk('td', 'num', fmt(d.wins)), mk('td', 'num' + (d.bonus ? '' : ' zero'), fmt(d.bonus)),
        mk('td', 'num total', fmt(d.points)), mk('td', 'num', d.this_week), mk('td', 'num hide-sm' + (d.weeks_won ? '' : ' zero'), d.weeks_won),
        bc);
      lb.append(tr);
    });

    renderMatchups(C, slate);

    // this week tiles
    const cur = weekly[weekly.length - 1];
    $('recap-dates').textContent = cur ? `Week ${cur.week}: ${fmtDay(cur.start)} – ${fmtDay(cur.end)}.` : '';
    const weekGames = C.sorted.filter((g) => cur && g.date >= cur.start && g.date <= cur.end);
    const teamWeek = new Map(teams.map((t) => [t.team, 0]));
    for (const g of weekGames) { const wn = g.home_score > g.away_score ? g.home : g.away; teamWeek.set(wn, (teamWeek.get(wn) || 0) + 1); }
    const hot = teams.slice().sort((a, b) => teamWeek.get(b.team) - teamWeek.get(a.team) || a.team.localeCompare(b.team))[0];
    const diff = (t) => (t.pace ?? 0) - (t.proj ?? 0);
    const up = teams.slice().sort((a, b) => diff(b) - diff(a))[0], down = teams.slice().sort((a, b) => diff(a) - diff(b))[0];
    const sign = (x) => (x >= 0 ? '+' : '') + x.toFixed(1);
    const tiles = [
      ['👑', 'Week leader', cur ? cur.winners.join(' & ') || '—' : '—', cur ? cur.best + (cur.best === 1 ? ' win' : ' wins') + ' this week' : '', null, 'gold'],
      ['🔥', 'Hottest team', hot ? hot.team : '—', hot ? teamWeek.get(hot.team) + (teamWeek.get(hot.team) === 1 ? ' win' : ' wins') + ' this week · ' + hot.owner : '', hot && hot.team, 'fire'],
      ['📈', 'Biggest overachiever', up ? up.team : '—', up ? 'Win pace ' + sign(diff(up)) + ' vs preseason · ' + up.owner : '', up && up.team, 'up'],
      ['📉', 'Biggest letdown', down ? down.team : '—', down ? 'Win pace ' + sign(diff(down)) + ' vs preseason · ' + down.owner : '', down && down.team, 'down'],
    ];
    const rc = $('recap'); rc.replaceChildren();
    tiles.forEach(([icon, l, n, d, team, tone]) => {
      const t = mk('div', 'tile bubble ' + tone);
      const top = mk('div', 'bubble-icon');
      if (team && TEAM_BADGE[team]) top.append(badge(team, 'badge bubble-badge'));
      else top.append(mk('span', 'bubble-emoji', icon));
      const label = mk('div', 'tile-label'); label.append(team ? icon + ' ' : '', l);
      t.append(top, label, mk('div', 'tile-name', n), mk('div', 'tile-detail', d));
      rc.append(t);
    });

    // last night's results
    const today = slate.date || pacificToday();
    const prior = C.sorted.filter((g) => g.date < today);
    const lastDay = prior.length ? prior[prior.length - 1].date : null;
    const res = prior.filter((g) => g.date === lastDay);
    const rb = document.querySelector('#results-table tbody'); rb.replaceChildren();
    $('results-empty').hidden = res.length > 0;
    if (lastDay && $('results-date')) $('results-date').textContent = fmtDay(lastDay) + ' · winners keep their colors; the owner who picked up the win gets +1.';
    res.forEach((g) => { const tr = mk('tr'); const td = mk('td'); td.append(resultRow(g, owner)); tr.append(td); rb.append(tr); });

    // weekly winners
    const wb = document.querySelector('#week-table tbody'); wb.replaceChildren();
    weekly.slice().reverse().forEach((w) => {
      const tr = mk('tr', w.current ? 'lead' : null);
      tr.append(mk('td', null, w.week), mk('td', 'zero', w.start), mk('td', 'zero', w.end), mk('td', 'total', w.winners.join(' & ') || 'No wins yet'),
        mk('td', 'num', w.best), mk('td', 'zero', w.current ? 'In progress' : 'Final'));
      wb.append(tr);
    });

    // owner cards
    const og = $('owner-grid'); og.replaceChildren();
    // Cards follow the current standings, so the order updates every time scores do.
    const order = board.map((b) => b.owner);
    order.forEach((o) => {
      const row = board.find((b) => b.owner === o);
      const card = mk('section', 'card ' + (row.points > 0 ? medal(row.place) || '' : '')); card.id = 'owner-' + o.toLowerCase();
      const head = mk('div', 'owner-head');
      const nameBox = mk('div'); nameBox.append(mk('h2', null, o));
      const pl = mk('div', 'projline', 'Proj. wins ');
      pl.append(mk('b', null, row.proj), ' · Win pace ');
      pl.append(mk('b', paceClass(row.pace, row.proj), row.pace.toFixed(1)));
      const plLine = pl;
      const pts = mk('div', 'owner-pts', fmt(row.points)); pts.append(mk('small', null, 'pts'));
      const side = mk('div', 'owner-side'); side.append(todayPill(o, C, slate), pts);
      head.append(nameBox, side);
      const tied = board.filter((x) => x.points === row.points).length > 1;
      const rk = mk('span', 'rank-bit', 'Rank '); rk.append(mk('b', null, `${tied ? 'T-' : ''}${row.place} of ${board.length}`)); pl.append(' · ', rk);
      card.append(head, plLine);
      const tb = mk('table', 'teams');
      const th = mk('thead'); const htr = mk('tr');
      [['Team', ''], ['W', 'num'], ['L', 'num'], ['Proj. wins', 'num'], ['Win pace', 'num'], ['Pts', 'num']].forEach(([t, c]) => htr.append(mk('th', c, t)));
      const lab = mk('tr', 'sched-head'); const lth = mk('th'); lth.colSpan = 6;
      const lw = mk('div', 'sched'); lw.append(mk('span', 'sched-side sched-lab', 'Last 3'), mk('span', 'sched-div'), mk('span', 'sched-side sched-lab', 'Next 3'));
      lth.append(lw); lab.append(lth);
      th.append(htr, lab); tb.append(th);
      const body = mk('tbody');
      teams.filter((t) => t.owner === o).sort((a, b) => b.points - a.points || a.team.localeCompare(b.team)).forEach((t) => {
        const tr = mk('tr', 'team-row');
        const name = mk('td', null, short(t.team));
        tr.append(name, mk('td', 'num', t.wins), mk('td', 'num zero', t.losses), mk('td', 'num zero', t.proj ?? ''),
          mk('td', 'num ' + paceClass(t.pace, t.proj), t.pace == null ? '' : t.pace.toFixed(1)), mk('td', 'num total', t.points));
        const sr = schedRow(t.team, t.last3);
        body.append(tr, sr);
        makeExpandable(name, t.team, () => sr);
      });
      tb.append(body); card.append(tb); og.append(card);
    });

    // bonuses
    const bb = document.querySelector('#bonus-table tbody'); bb.replaceChildren();
    const withB = teams.slice().sort((a, b) => b.bonus - a.bonus || a.owner.localeCompare(b.owner) || a.team.localeCompare(b.team));
    $('bonus-empty').hidden = teams.some((t) => t.bonus > 0); $('bonus-table').hidden = false;
    withB.forEach((t) => {
      const tr = mk('tr', t.bonus ? 'has-bonus' : 'no-bonus');
      const tot = mk('td', 'num'); const btn = mk('button', 'bonus-btn' + (t.bonus ? '' : ' zero-btn'), String(t.bonus)); btn.type = 'button';
      btn.setAttribute('aria-label', `Show bonus breakdown for ${short(t.team)}`);
      btn.addEventListener('click', () => showBonus(t)); tot.append(btn);
      tr.append(mk('td', null, short(t.team)), mk('td', null, t.owner), tot);
      bb.append(tr);
    });

    // upset watch
    const ut = document.querySelector('#upset-tally tbody'); ut.replaceChildren();
    C.owners.map((o) => {
      const m = upsets.filter((u) => u.owner === o);
      return { o, u: m.filter((x) => x.pts === 1).length, b: m.filter((x) => x.pts === 2).length, s: m.filter((x) => x.pts === 3).length,
        pts: m.reduce((a, x) => a + x.pts, 0), longest: m.length ? Math.max(...m.map((x) => x.ml)) : null };
    }).sort((a, b) => b.pts - a.pts || (b.longest || 0) - (a.longest || 0) || a.o.localeCompare(b.o)).forEach((d, i) => {
      const tr = mk('tr', d.pts > 0 ? medal(i + 1) : null); const c = (n) => mk('td', 'num' + (n ? '' : ' zero'), n);
      tr.append(mk('td', 'total', d.o), c(d.u), c(d.b), c(d.s), mk('td', 'num' + (d.pts ? ' total' : ' zero'), d.pts), mk('td', 'num zero', d.longest ? '+' + d.longest : '—'));
      ut.append(tr);
    });
    const ul = document.querySelector('#upset-list tbody'); ul.replaceChildren();
    $('upset-empty').hidden = upsets.length > 0; $('upset-list').hidden = upsets.length === 0;
    upsets.forEach((u) => {
      const tr = mk('tr');
      tr.append(mk('td', 'zero', fmtDay(u.date)), mk('td', 'total', short(u.team)), mk('td', null, u.owner), mk('td', null, short(u.opp)),
        mk('td', 'num up', '+' + u.ml), mk('td', null, `${u.tier} (+${u.pts})`), mk('td', 'num', u.score));
      ul.append(tr);
    });

    renderStrip(slate, C);

    if (D.meta && D.meta.updated) {
      const t = new Date(D.meta.updated).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      $('foot').textContent = `Last data update: ${t} Pacific. Scores from ESPN’s public scoreboard, refreshed every 15 minutes from 9 AM to 1 AM Pacific. Preseason lines from Hoops Rumors.`;
    }
  }

  function renderMatchups(C, slate) {
    const { matchups, h2hTable, curWeek } = C;
    const signed = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0');
    // featured week: the current one (or the first upcoming one before matchups start)
    const featuredWeek = matchups.some((m) => m.week === curWeek) ? curWeek : (matchups[0] || {}).week;
    const cur = matchups.filter((m) => m.week === featuredWeek);
    const box = $('mu-current'); box.replaceChildren();
    if (cur.length) {
      const m0 = cur[0];
      const label = m0.status === 'live' ? 'In progress' : m0.status === 'final' ? 'Final' : 'Upcoming';
      box.append(mk('div', 'mu-title', `Week ${m0.week} · ${fmtDay(m0.start)} – ${fmtDay(m0.end)} · ${label}`));
      const row = mk('div', 'mu-row');
      cur.forEach((m) => {
        const card = mk('div', 'mu-card' + (m.status === 'live' ? ' live' : ''));
        [m.A, m.B].forEach((s) => {
          const lead = m.winner === s.owner;
          const line = mk('div', 'mu-side' + (lead ? ' lead' : m.winner ? ' trail' : ''));
          const ow = mk('span', 'mu-owner', s.owner);
          if (m.status !== 'final') {
            const tc = todayCount(s.owner, C, slate);
            const t = mk('button', 'mu-today' + (tc.live ? ' live' : !tc.total || tc.done === tc.total ? ' quiet' : ''),
              tc.live ? `● ${tc.live} live` : !tc.total ? 'Off today' : tc.done === tc.total ? `${tc.total} done` : `${tc.total} today`);
            t.type = 'button'; t.setAttribute('aria-label', `Show ${s.owner}'s games today`);
            t.addEventListener('click', () => showToday(s.owner, C, slate));
            ow.append(t);
          }
          line.append(ow, mk('span', 'mu-rec', `${s.w}–${s.l}`), mk('span', 'mu-net' + (s.net < 0 ? ' neg' : ''), signed(s.net)));
          card.append(line);
        });
        const foot = m.status === 'upcoming' ? 'Starts ' + fmtDay(m.start)
          : !m.winner ? (m.status === 'final' ? 'Tie' : 'Even so far')
          : m.status === 'final' ? m.winner + ' wins' : m.winner + ' leads';
        card.append(mk('div', 'mu-foot', foot));
        row.append(card);
      });
      box.append(row);
    }

    const hb = document.querySelector('#h2h-table tbody'); hb.replaceChildren();
    h2hTable.forEach((r, i) => {
      const tr = mk('tr', (r.w + r.t) > 0 ? medal(i + 1) : null);
      tr.append(mk('td', 'rank', i + 1), mk('td', 'total', r.owner), mk('td', 'num total', r.t ? `${r.w}–${r.l}–${r.t}` : `${r.w}–${r.l}`),
        mk('td', 'num' + (r.net > 0 ? ' up' : r.net < 0 ? ' down' : ' zero'), signed(r.net)), mk('td', 'num h2h-wins', r.wins));
      hb.append(tr);
    });

    const sb = document.querySelector('#mu-sched tbody'); sb.replaceChildren();
    matchups.slice().sort((a, b) => b.week - a.week).forEach((m) => {
      const tr = mk('tr', m.status === 'live' ? 'mu-live-row' : null);
      const res = m.status === 'upcoming' ? '—'
        : `${m.A.w}–${m.A.l} vs ${m.B.w}–${m.B.l}` + (m.status === 'final' ? (m.winner ? ' · ' + m.winner : ' · Tie') : ' · live');
      const who = mk('td');
      const cls = (o) => !m.winner ? null
        : m.status === 'live' ? (m.winner === o ? 'mu-win' : 'mu-lose')
        : m.status === 'final' ? (m.winner === o ? 'total' : 'zero') : null;
      const a = mk('span', cls(m.A.owner), m.A.owner);
      const b = mk('span', cls(m.B.owner), m.B.owner);
      who.append(a, ' vs ', b);
      tr.append(mk('td', 'zero', m.week), who, mk('td', 'num' + (m.status === 'upcoming' ? ' zero' : ''), res));
      sb.append(tr);
    });
  }

  // ---------- an owner's games today pop-up ----------
  function showToday(owner, C, slate) {
    closeBonus();
    const gs = ((slate && slate.games) || []).filter((g) => C.owner.get(g.away) === owner || C.owner.get(g.home) === owner);
    const ov = mk('div', 'bp-overlay'); ov.id = 'bonus-pop';
    const box = mk('div', 'bp-box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', owner + ' games today');
    const head = mk('div', 'bp-head');
    const ttl = mk('div', 'bp-title'); ttl.append(mk('b', null, `${owner}'s games today`), mk('span', null, dayName(pacificToday(), { weekday: 'long', month: 'short', day: 'numeric' }))); head.append(ttl);
    const x = mk('button', 'bp-close', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.addEventListener('click', closeBonus); head.append(x);
    box.append(head);
    if (!gs.length) box.append(mk('p', 'players-msg', 'None of their teams play today.'));
    gs.forEach((g) => {
      const final = g.state === 'post', live = g.state === 'in';
      const card = mk('div', 'tg-game' + (live ? ' live' : '') + (g.cup ? ' cup' : ''));
      const st = mk('div', 'tg-status');
      st.append(mk('span', live ? 'tg-live' : null, final ? 'FINAL' : live ? '● ' + (g.detail || 'LIVE') : g.time));
      if (g.cup) st.append(mk('span', 'tg-cup', '🏆 NBA Cup'));
      card.append(st);
      const winner = final ? (g.home_score > g.away_score ? g.home : g.away) : null;
      [[g.away, g.away_score, true], [g.home, g.home_score, false]].forEach(([team, pts, away]) => {
        const mine = C.owner.get(team) === owner;
        const r = mk('div', 'tg-row' + (mine ? ' mine' : '') + (final ? (team === winner ? ' won' : ' lost') : ''));
        const nm = mk('span', 'tg-team'); nm.append(mk('span', 'tg-name', (away ? '' : '@ ') + short(team)), mk('span', 'tg-owner', C.owner.get(team) || ''));
        r.append(badge(team, 'sb-badge'), nm, mk('span', 'tg-pts', final || live ? String(pts ?? '') : ''));
        if (final && team === winner && mine) r.append(mk('span', 'plus', g.cup ? '+2' : '+1'));
        card.append(r);
      });
      box.append(card);
    });
    ov.append(box);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeBonus(); });
    document.body.append(ov); document.addEventListener('keydown', bonusKey); x.focus();
  }

  // ---------- bonus breakdown pop-up ----------
  function showBonus(t) {
    closeBonus();
    const S = D.config.scoring;
    const ov = mk('div', 'bp-overlay'); ov.id = 'bonus-pop';
    const box = mk('div', 'bp-box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', short(t.team) + ' bonus breakdown');
    const head = mk('div', 'bp-head'); head.append(badge(t.team, 'badge'));
    const ttl = mk('div', 'bp-title'); ttl.append(mk('b', null, t.team), mk('span', null, t.owner)); head.append(ttl);
    const x = mk('button', 'bp-close', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.addEventListener('click', closeBonus); head.append(x);
    const tb = mk('table', 'bp-table'); const body = mk('tbody');
    const row = (label, detail, pts) => { const r = mk('tr', pts ? null : 'bp-zero'); const l = mk('td'); l.append(mk('span', 'bp-label', label)); if (detail) l.append(mk('span', 'bp-detail', detail)); r.append(l, mk('td', 'num', pts ? '+' + pts : '0')); body.append(r); };
    row('NBA Cup game wins', `${t.cup_wins} ${t.cup_wins === 1 ? 'win' : 'wins'} × 1 extra point`, t.pts_cupgames);
    row('Made the playoffs', t.made ? 'Yes' : 'Not yet', t.pts_playoffs);
    row('Playoff game wins', `${t.playoff_wins} ${t.playoff_wins === 1 ? 'win' : 'wins'} × ${S.playoff_win}`, t.pts_pw);
    row('Won the NBA Cup', t.pts_cup ? 'Champions' : 'Not yet', t.pts_cup);
    const f = mk('tr', 'bp-total'); f.append(mk('td', null, 'Total bonus'), mk('td', 'num', String(t.bonus))); body.append(f);
    tb.append(body); box.append(head, tb); ov.append(box);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeBonus(); });
    document.body.append(ov); document.addEventListener('keydown', bonusKey); x.focus();
  }
  function closeBonus() { const o = document.getElementById('bonus-pop'); if (o) o.remove(); document.removeEventListener('keydown', bonusKey); }
  function bonusKey(e) { if (e.key === 'Escape') closeBonus(); }

  function medal(rank) { return rank === 1 ? 'p1' : rank === 2 ? 'p2' : rank === 3 ? 'p3' : null; }

  function paceClass(pace, pre) { return pace == null || pre == null || pace === pre ? 'zero' : pace > pre ? 'up' : 'down'; }

  function sideEl(team, ownerName, state, cupGame) {
    const wrap = mk('div', 'side' + (state ? ' ' + state : ''));
    const o = mk('div', 'side-owner', ownerName || '—');
    if (state === 'won') o.append(mk('span', 'plus', cupGame ? '+2' : '+1'));
    wrap.append(badge(team, 'badge'), o);
    return wrap;
  }
  function resultRow(g, owner) {
    const awayWon = g.away_score > g.home_score;
    const row = mk('div', 'matchup');
    const sc = mk('div', 'score');
    sc.append(mk('span', awayWon ? 'hi' : null, g.away_score), mk('span', null, '–'), mk('span', awayWon ? null : 'hi', g.home_score));
    row.append(sideEl(g.away, owner.get(g.away), awayWon ? 'won' : 'lost', g.cup), sc, sideEl(g.home, owner.get(g.home), awayWon ? 'lost' : 'won', g.cup));
    return row;
  }

  function renderStrip(slate, C) {
    const strip = $('sb-strip'); strip.replaceChildren();
    const date = slate.date || pacificToday();
    $('sb-date').querySelector('.sb-dow').textContent = dayName(date, { weekday: 'short' }).toUpperCase();
    $('sb-date').querySelector('.sb-md').textContent = dayName(date, { month: 'short', day: 'numeric' }).toUpperCase();
    if (!slate.games.length) { strip.append(mk('div', 'sb-none', 'No games today')); return; }
    slate.games.forEach((g) => {
      const final = g.state === 'post', live = g.state === 'in';
      const card = mk('div', 'sb-card ' + (final ? 'final' : live ? 'live' : 'pre') + (g.cup ? ' cup' : ''));
      const ln = C.lineOf.get(date + '|' + g.away + '|' + g.home);
      const st = mk('div', 'sb-status');
      st.append(mk('span', null, final ? 'FINAL' : live ? (g.detail || 'LIVE') : g.time));
      if (ln && ln.fav && ln.spread != null) st.append(mk('span', 'sb-line', ln.spread === 0 ? 'PK' : (TEAM_BADGE[ln.fav] || [short(ln.fav)])[0] + ' −' + ln.spread));
      card.append(st);
      const winner = final ? (g.home_score > g.away_score ? g.home : g.away) : null;
      [[g.away, g.away_score, ln && ln.away_ml], [g.home, g.home_score, ln && ln.home_ml]].forEach(([team, pts, line]) => {
        const row = mk('div', 'sb-row' + (final ? (team === winner ? ' won-row' : ' lost-row') : ''));
        const nm = mk('span', 'sb-team'); nm.append(mk('span', 'sb-name', short(team)), mk('span', 'sb-owner', C.owner.get(team) || ''));
        row.append(badge(team, 'sb-badge'), nm, final || live ? mk('span', 'sb-pts', pts ?? '') : mk('span', 'sb-ml', ml(line)), mk('span', 'sb-arrow', team === winner ? '◂' : ''));
        card.append(row);
      });
      const ao = C.owner.get(g.away), ho = C.owner.get(g.home);
      const foot = final ? (C.owner.get(winner) || '') + (g.cup ? ' +2' : ' +1') : ao === ho ? ho + (g.cup ? ' either way' : ' wins either way') : `${ao || '—'} vs ${ho || '—'}`;
      const ft = mk('div', 'sb-foot');
      if (g.cup) { ft.append(mk('span', 'sb-cup', '🏆 ')); card.title = 'NBA Cup game: each win is worth 2 points'; }
      ft.append(foot); card.append(ft);
      strip.append(card);
    });
  }

  // ---------- boot ----------
  let D, slate;
  async function load() {
    const names = ['rosters', 'projections', 'games', 'lines', 'bonuses', 'config', 'today', 'meta', 'schedule'];
    const vals = await Promise.all(names.map((n) => getJSON('data/' + n + '.json').catch(() => null)));
    D = Object.fromEntries(names.map((n, i) => [n, vals[i]]));
    D.games = D.games || []; D.lines = D.lines || []; D.bonuses = D.bonuses || [];
    slate = D.today && D.today.date === pacificToday() ? D.today : { date: pacificToday(), games: [] };
  }

  async function refreshLive() {
    const live = await liveSlate(pacificToday());
    if (live && live.length) {
      slate = { date: pacificToday(), games: live.filter((g) => g.season_type == null || g.season_type <= 3) };
      // Count today's finished regular-season games right away.
      const have = new Set(D.games.map((g) => g.date + '|' + g.away + '|' + g.home));
      for (const g of live) {
        if (g.state === 'post' && g.season_type === 2 && !have.has(slate.date + '|' + g.away + '|' + g.home)) {
          D.games.push({ id: g.id, date: slate.date, away: g.away, home: g.home, away_score: g.away_score, home_score: g.home_score, cup: !!g.cup });
        }
      }
    }
    render(D, compute(D), slate);
  }

  // ---------- tap a section title to collapse / expand it (remembered per browser) ----------
  function setupCollapsibles() {
    const KEY = 'pl-collapsed';
    let closed = new Set();
    try { closed = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch (e) { /* storage unavailable */ }
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...closed])); } catch (e) { /* ignore */ } };
    const sections = [...document.querySelectorAll('section.card')].filter((c) => c.id !== 'league-rules' && c.querySelector(':scope > h2'))
      .map((c) => ({ id: c.id, el: c, h: c.querySelector(':scope > h2') }));
    sections.forEach(({ id, el, h, extra }) => {
      h.classList.add('sec-toggle'); h.tabIndex = 0; h.setAttribute('role', 'button');
      const apply = () => {
        const shut = closed.has(id);
        el.classList.toggle('collapsed', shut); if (extra) extra.hidden = shut;
        h.setAttribute('aria-expanded', String(!shut));
      };
      const toggle = () => { closed.has(id) ? closed.delete(id) : closed.add(id); save(); apply(); };
      h.addEventListener('click', toggle);
      h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      apply();
    });
  }
  setupCollapsibles();

  // ---------- bottom tab bar: each tab shows its own group of sections ----------
  function setupTabs() {
    const TABS = ['home', 'matchups', 'rosters', 'more'];
    const groups = {
      home: ['scoreboard', 'leaderboard-card', 'recap-card', 'results-card'],
      matchups: ['matchups-card', 'weekly-card'],
      rosters: ['rosters-card'],
      more: ['bonus-card', 'upset-card', 'ideas-card', 'league-rules'],
    };
    Object.entries(groups).forEach(([tab, ids]) => ids.forEach((id) => {
      let el = document.getElementById(id); if (!el) return;
      if (id === 'bonus-card' && el.parentElement.classList.contains('grid')) el = el.parentElement;   // bonuses + scoring rules sit side by side
      el.dataset.tab = tab;
    }));
    const btns = [...document.querySelectorAll('#tabbar button')];
    const go = (tab, scroll) => {
      if (!TABS.includes(tab)) tab = 'home';
      document.body.dataset.tab = tab;
      const T = { home: ['NBA Points League', '2026–27 Season'], matchups: ['Matchups', 'NBA Points League'], rosters: ['Rosters', 'NBA Points League'], more: ['More', 'NBA Points League'] }[tab];
      const pm = document.querySelector('.pl-main'), ps = document.querySelector('.pl-sub');
      if (pm && ps && document.querySelector('link[href="apple.css"]')) { pm.textContent = T[0]; ps.textContent = T[1]; }
      btns.forEach((b) => { const on = b.dataset.go === tab; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
      try { localStorage.setItem('pl-tab', tab); } catch (e) { /* ignore */ }
      if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
      if (scroll) window.scrollTo({ top: 0 });
    };
    btns.forEach((b) => b.addEventListener('click', () => go(b.dataset.go, true)));
    window.addEventListener('hashchange', () => go(location.hash.slice(1), true));
    let start = location.hash.slice(1);
    if (!TABS.includes(start)) { try { start = localStorage.getItem('pl-tab') || 'home'; } catch (e) { start = 'home'; } }
    go(start, false);
  }
  setupTabs();

  (async () => {
    try {
      await load();
      render(D, compute(D), slate);
      await refreshLive();
      setInterval(refreshLive, 60 * 1000);
      setInterval(async () => { await load(); await refreshLive(); }, 10 * 60 * 1000);
    } catch (e) {
      console.error(e);
      ($('takeaway') || $('chips')).textContent = 'Couldn’t load the league data. Try refreshing in a minute.';
    }
  })();
})();
