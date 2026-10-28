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
  // minutes until a game's tip-off ("7:30 PM" Pacific on its date); null if not today or unknown
  const minsToTip = (date, time) => {
    if (!time || date !== pacificToday()) return null;
    const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(String(time).trim()); if (!m) return null;
    const tip = ((+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2];
    const [h, mi] = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number);
    return tip - (h * 60 + mi);
  };
  // "Starts in 12 min" when tip-off is 15 minutes away or less
  const soonLabel = (date, time) => { const n = minsToTip(date, time); return n != null && n <= 15 && n >= -5 ? (n <= 0 ? 'Tipping off' : `In ${n} min`) : null; };
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
      return { team: r.team, owner: r.owner, wins: w, losses: l, proj: pre, pace, last5: L.slice(-5).map((x) => (x.w ? 'W' : 'L')), last3: L.slice(-3), last5g: L.slice(-5),
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
      const lastWeek = Math.max(curWeek, M.start_week) + 4;  // through the current week, plus the next few as upcoming
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

  // ---------- My team: each viewer picks who they are (saved in their own browser) ----------
  const getMe = () => { try { return localStorage.getItem('pl-me') || null; } catch (e) { return null; } };
  const setMe = (o) => { try { o ? localStorage.setItem('pl-me', o) : localStorage.removeItem('pl-me'); } catch (e) { /* ignore */ } };
  function pickMe(C) {
    closeBonus();
    const ov = mk('div', 'bp-overlay'); ov.id = 'bonus-pop';
    const box = mk('div', 'bp-box me-pick'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Pick your team');
    const head = mk('div', 'bp-head'); const ttl = mk('div', 'bp-title'); ttl.append(mk('b', null, 'Who are you?'), mk('span', null, 'The site will highlight your teams and matchup.')); head.append(ttl);
    const x = mk('button', 'bp-close', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.addEventListener('click', closeBonus); head.append(x); box.append(head);
    const grid = mk('div', 'me-grid'); const me = getMe();
    [...C.owners].sort((a, b) => a.localeCompare(b)).forEach((o) => {
      const b = mk('button', 'me-opt' + (o === me ? ' on' : ''), o); b.type = 'button';
      b.addEventListener('click', () => { setMe(o); closeBonus(); rerender(); }); grid.append(b);
    });
    box.append(grid);
    if (me) { const off = mk('button', 'me-off', 'Turn off My team'); off.type = 'button'; off.addEventListener('click', () => { setMe(null); closeBonus(); rerender(); }); box.append(off); }
    ov.append(box); ov.addEventListener('click', (e) => { if (e.target === ov) closeBonus(); });
    document.body.append(ov); document.addEventListener('keydown', bonusKey); x.focus();
  }
  const rerender = () => { if (D) render(D, compute(D), slate); };

  function renderMe(C, slate) {
    const host = $('me-body'); if (!host) return;
    const me = getMe(); host.replaceChildren();
    $('me-card').classList.toggle('me-empty', !me);
    if (!me || !C.owners.includes(me)) {
      host.append(mk('p', 'me-ask', 'Pick who you are and the site highlights your teams, your matchup and your games.'));
      const grid = mk('div', 'me-grid'); [...C.owners].sort((a, b) => a.localeCompare(b)).forEach((o) => { const b = mk('button', 'me-opt', o); b.type = 'button'; b.addEventListener('click', () => { setMe(o); rerender(); }); grid.append(b); });
      host.append(grid); return;
    }
    const row = C.board.find((b) => b.owner === me), lead = C.board[0];
    const tied = C.board.filter((x) => x.points === row.points).length > 1;
    const top = mk('div', 'me-top');
    const who = mk('div', 'me-who'); who.append(mk('span', 'me-hi', 'Your team'), mk('b', null, me));
    const sw = mk('button', 'me-switch', 'Switch'); sw.type = 'button'; sw.addEventListener('click', () => pickMe(C));
    top.append(who, sw); host.append(top);
    const tiles = mk('div', 'me-tiles');
    const tile = (label, value, sub, cls) => { const d = mk('div', 'me-tile'); d.append(mk('span', 'me-tl', label), mk('b', cls || null, value)); if (sub) d.append(mk('span', 'me-ts', sub)); tiles.append(d); return d; };
    const gap = lead.points - row.points, second = C.board.find((b) => b.owner !== me);
    tile('Rank', `${tied ? 'T-' : ''}${row.place}`, `of ${C.board.length}`);
    tile('Points', fmt(row.points), row.place === 1 && !tied ? `+${row.points - (second ? second.points : 0)} ahead` : gap ? `${gap} behind 1st` : 'tied for 1st');
    // this week's matchup
    const fw = C.matchups.some((m) => m.week === C.curWeek) ? C.curWeek : (C.matchups[0] || {}).week;
    const m = C.matchups.find((x) => x.week === fw && (x.A.owner === me || x.B.owner === me));
    if (m) {
      const mine = m.A.owner === me ? m.A : m.B, opp = m.A.owner === me ? m.B : m.A;
      const state = m.status === 'upcoming' ? 'Starts ' + fmtDay(m.start) : m.winner === me ? (m.status === 'final' ? 'You won' : 'You lead') : m.winner ? (m.status === 'final' ? 'You lost' : 'You trail') : (m.status === 'final' ? 'Tie' : 'Even');
      const t = tile('Matchup vs ' + opp.owner, `${mine.w}–${mine.l}`, `${state} · ${opp.owner} ${opp.w}–${opp.l}`, m.winner === me ? 'up' : m.winner ? 'down' : null);
      t.classList.add('me-tap'); t.tabIndex = 0; t.setAttribute('role', 'button');
      const go = () => { location.hash = '#matchups'; }; t.addEventListener('click', go); t.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    }
    const tc = todayCount(me, C, slate);
    const t2 = tile('Today', tc.live ? `${tc.live} live` : `${tc.total}`, tc.live ? `of ${tc.total} games` : tc.total ? (tc.done === tc.total ? 'all played' : (tc.total === 1 ? 'game' : 'games')) : 'no games', tc.live ? 'down' : null);
    t2.classList.add('me-tap'); t2.tabIndex = 0; t2.setAttribute('role', 'button');
    t2.addEventListener('click', () => showToday(me, C, slate)); t2.addEventListener('keydown', (e) => { if (e.key === 'Enter') showToday(me, C, slate); });
    host.append(tiles);
  }

  function render(D, C, slate) {
    const { board, teams, weekly, upsets, owner } = C;
    const me = getMe();
    document.body.classList.toggle('has-me', !!me);
    renderMe(C, slate);

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
      const chip = (icon, text, cls, onTap) => {
        const c = mk(onTap ? 'button' : 'span', 'chip' + (cls ? ' ' + cls : '') + (onTap ? ' chip-btn' : '')); c.append(mk('span', 'chip-i', icon), text);
        if (onTap) { c.type = 'button'; c.setAttribute('aria-label', text + ': show today\'s games'); c.addEventListener('click', onTap); }
        chips.append(c); return c;
      };
      const openAll = () => showToday(null, C, slate);
      if (C.curWeek) chip('📅', 'Week ' + C.curWeek);
      const gs = (slate && slate.games) || [];
      const liveN = gs.filter((g) => g.state === 'in').length;
      const gc = liveN ? chip('●', liveN + (liveN === 1 ? ' game' : ' games') + ' live', 'live', openAll)
        : gs.length ? chip('🏀', gs.length + (gs.length === 1 ? ' game' : ' games') + ' today', null, openAll)
        : chip('🏀', 'No games today', null, openAll);
      // same chip in the slim bar that pins to the top while scrolling
      const mc = $('pl-mini-chip');
      if (mc) { mc.replaceChildren(...[...gc.childNodes].map((n) => n.cloneNode(true))); mc.className = 'chip chip-btn' + (liveN ? ' live' : ''); mc.onclick = openAll; }
      const start = (D.config && D.config.season_start) || '2026-10-20';
      const day = Math.floor((new Date(pacificToday()) - new Date(start)) / 864e5) + 1;
      if (day > 0) chip('⏱', 'Day ' + day + ' of the season');
      chip('👤', me ? me : 'Pick your team', 'me-chip', () => pickMe(C));
    }

    // leaderboard
    const lb = document.querySelector('#leaderboard tbody');
    // remember where each owner's row was and their points, so changes can animate
    const prevTop = new Map([...lb.children].map((r) => [r.dataset.owner, r.getBoundingClientRect().top]));
    const prevPts = new Map([...lb.children].map((r) => [r.dataset.owner, r.dataset.pts]));
    lb.replaceChildren();
    board.forEach((d, i) => {
      const tr = mk('tr', [d.points > 0 ? medal(d.place) : null, d.owner === me ? 'is-me' : null].filter(Boolean).join(' ') || null);
      const nmTd = mk('td', 'total', d.owner); if (d.owner === me) nmTd.append(mk('span', 'you-tag', 'You'));
      tr.append(mk('td', 'rank', d.rank), nmTd, mk('td', 'num', fmt(d.wins)), mk('td', 'num' + (d.bonus ? '' : ' zero'), fmt(d.bonus)),
        mk('td', 'num total', fmt(d.points)), mk('td', 'num', d.this_week), mk('td', 'num hide-sm' + (d.weeks_won ? '' : ' zero'), d.weeks_won));
      tr.dataset.owner = d.owner; tr.dataset.pts = d.points;
      if (prevPts.size && prevPts.has(d.owner) && prevPts.get(d.owner) !== String(d.points)) tr.classList.add('pts-up');
      lb.append(tr);
    });
    if (prevTop.size && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      [...lb.children].forEach((r) => {
        const was = prevTop.get(r.dataset.owner); if (was == null) return;
        const dy = was - r.getBoundingClientRect().top; if (Math.abs(dy) < 2) return;
        r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
      });
    }

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
    const wb = document.querySelector('#week-table tbody'); if (wb) wb.replaceChildren();
    if (wb) weekly.slice().reverse().forEach((w) => {
      const tr = mk('tr', w.current ? 'lead' : null);
      tr.append(mk('td', null, w.week), mk('td', 'zero', w.start), mk('td', 'zero', w.end), mk('td', 'total', w.winners.join(' & ') || 'No wins yet'),
        mk('td', 'num', w.best), mk('td', 'zero', w.current ? 'In progress' : 'Final'));
      wb.append(tr);
    });

    // owner cards
    const og = $('owner-grid'); og.replaceChildren();
    // Cards follow the current standings, so the order updates every time scores do.
    const order = board.map((b) => b.owner).sort((a, b) => (b === me) - (a === me));
    order.forEach((o) => {
      const row = board.find((b) => b.owner === o);
      const card = mk('section', 'card ' + (row.points > 0 ? medal(row.place) || '' : '')); card.id = 'owner-' + o.toLowerCase(); if (o === me) card.classList.add('is-me');
      const head = mk('div', 'owner-head');
      const nameBox = mk('div'); const h2o = mk('h2', null, o); if (o === me) h2o.append(mk('span', 'you-tag', 'You')); nameBox.append(h2o);
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
      const tb = mk('table', 'teams teams-simple');
      const th = mk('thead'); const htr = mk('tr');
      [['Team', ''], ['W', 'num'], ['L', 'num'], ['Win pace', 'num']].forEach(([t, c]) => htr.append(mk('th', c, t)));
      th.append(htr); tb.append(th);
      const body = mk('tbody');
      teams.filter((t) => t.owner === o).sort((a, b) => b.points - a.points || a.team.localeCompare(b.team)).forEach((t) => {
        const tr = mk('tr', 'team-row');
        const name = mk('td', 'team-cell'); name.append(badge(t.team, 'sb-badge team-logo'), mk('span', 'team-nm', short(t.team)));
        const pace = mk('td', 'num pace-cell ' + paceClass(t.pace, t.proj), t.pace == null ? '–' : t.pace.toFixed(1)); pace.append(mk('span', 'row-go', '›'));
        tr.append(name, mk('td', 'num', t.wins), mk('td', 'num', t.losses), pace);
        tr.tabIndex = 0; tr.setAttribute('role', 'button'); tr.setAttribute('aria-label', `Open the ${t.team} team card`);
        tr.addEventListener('click', () => showTeam(t, C, slate));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTeam(t, C, slate); } });
        body.append(tr);
      });
      tb.append(body); card.append(tb); og.append(card);
    });

    renderRace(D, C);

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

  // ---------- Matchups: week switcher, scoreboard cards, games left, detail sheet ----------
  let muWeek = null;   // week shown in Matchups (null = the current week)
  const signedN = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0');
  // every game an owner's teams play in a given matchup week: played results plus what's left
  function ownerWeekGames(owner, m, C, slate) {
    const out = [], seen = new Set(), today = pacificToday();
    for (const g of C.sorted) {
      if (g.date < m.start || g.date > m.end) continue;
      const mine = [g.away, g.home].filter((x) => C.owner.get(x) === owner); if (!mine.length) continue;
      seen.add(g.date + '|' + g.away + '|' + g.home);
      { const team = mine.length === 2 ? (g.home_score > g.away_score ? g.home : g.away) : mine[0];
        const home = g.home === team, us = home ? g.home_score : g.away_score, them = home ? g.away_score : g.home_score;
        out.push({ date: g.date, team, opp: home ? g.away : g.home, home, state: 'final', w: us > them, score: `${us}–${them}`, cup: g.cup, both: mine.length === 2 }); }
    }
    const pending = [];
    ((slate && slate.games) || []).forEach((g) => { if (g.state === 'in') pending.push({ ...g, date: today, live: true }); });
    ((D.schedule && D.schedule.games) || []).forEach((g) => pending.push(g));
    for (const g of pending) {
      if (g.date < m.start || g.date > m.end || g.date < today) continue;
      const key = g.date + '|' + g.away + '|' + g.home; if (seen.has(key)) continue;
      const mine = [g.away, g.home].filter((x) => C.owner.get(x) === owner); if (!mine.length) continue;
      seen.add(key);
      { const team = mine[mine.length === 2 ? 1 : 0], home = g.home === team;
        out.push({ date: g.date, team, opp: home ? g.away : g.home, home, state: g.live ? 'live' : 'pre', time: g.time, detail: g.detail,
          score: g.live ? `${home ? g.home_score : g.away_score}–${home ? g.away_score : g.home_score}` : '', cup: g.cup, both: mine.length === 2 }); }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  function renderMatchups(C, slate) {
    const { matchups, h2hTable, curWeek } = C;
    const me = getMe();
    const weeks = [...new Set(matchups.map((m) => m.week))].sort((a, b) => a - b);
    const current = weeks.includes(curWeek) ? curWeek : weeks[0];
    if (muWeek == null || !weeks.includes(muWeek)) muWeek = current;
    const box = $('mu-current'); box.replaceChildren();
    const cur = matchups.filter((m) => m.week === muWeek).sort((a, b) => ((b.A.owner === me || b.B.owner === me) - (a.A.owner === me || a.B.owner === me)));
    if (cur.length) {
      const m0 = cur[0];
      // week switcher
      const nav = mk('div', 'mw-nav');
      const go = (d) => { const k = weeks.indexOf(muWeek) + d; if (k >= 0 && k < weeks.length) { muWeek = weeks[k]; renderMatchups(C, slate); } };
      const prevB = mk('button', 'mw-arrow', '‹'); prevB.type = 'button'; prevB.setAttribute('aria-label', 'Previous week'); prevB.disabled = muWeek === weeks[0]; prevB.addEventListener('click', () => go(-1));
      const nextB = mk('button', 'mw-arrow', '›'); nextB.type = 'button'; nextB.setAttribute('aria-label', 'Next week'); nextB.disabled = muWeek === weeks[weeks.length - 1]; nextB.addEventListener('click', () => go(1));
      const label = m0.status === 'live' ? 'In progress' : m0.status === 'final' ? 'Final' : 'Upcoming';
      const mid = mk('div', 'mw-mid'); mid.append(mk('b', null, 'Week ' + muWeek), mk('span', 'mw-sub', `${dayName(m0.start, { month: 'short', day: 'numeric' })} – ${dayName(m0.end, { month: 'short', day: 'numeric' })} · `));
      mid.lastChild.append(mk('span', 'mw-status ' + m0.status, label));
      if (muWeek !== current) { const back = mk('button', 'mw-today', '↩ Back to this week'); back.type = 'button'; back.addEventListener('click', () => { muWeek = current; renderMatchups(C, slate); }); mid.append(back); }
      nav.append(prevB, mid, nextB); box.append(nav);
      // most wins that week (the old Weekly winners table, folded in)
      const wk = C.weekly[muWeek - 1];
      if (wk && wk.best > 0) { const ww = mk('div', 'mw-winner'); ww.append(mk('span', null, m0.status === 'final' ? '👑 Most wins: ' : '👑 Most wins so far: '), mk('b', null, wk.winners.join(' & ')), mk('span', 'mw-dim', ` · ${wk.best} wins`)); box.append(ww); }
      // scoreboard cards
      const row = mk('div', 'mw-row');
      cur.forEach((m) => {
        const isMe = m.A.owner === me || m.B.owner === me;
        const card = mk('button', 'mw-card ' + m.status + (isMe ? ' is-me' : '')); card.type = 'button';
        card.setAttribute('aria-label', `Week ${m.week}: ${m.A.owner} vs ${m.B.owner}. Show details`);
        card.addEventListener('click', () => showMatchup(m, C, slate));
        const sideEl = (sd, right) => {
          const gl = ownerWeekGames(sd.owner, m, C, slate), left = gl.filter((g) => g.state !== 'final').length, live = gl.filter((g) => g.state === 'live').length;
          const el = mk('div', 'mw-side' + (right ? ' r' : '') + (m.winner === sd.owner ? ' lead' : m.winner ? ' trail' : ''));
          el.append(mk('span', 'mw-name', sd.owner));
          const sub = mk('span', 'mw-sub2'); sub.append(mk('span', 'mw-rec', `${sd.w}–${sd.l}`));
          if (m.status !== 'final') sub.append(mk('span', 'mw-left' + (live ? ' live' : ''), live ? ` · ● ${live} live` : ` · ${left} left`));
          el.append(sub); return el;
        };
        const score = mk('div', 'mw-score');
        score.append(mk('span', 'mw-net' + (m.A.net > m.B.net ? ' hi' : ''), m.status === 'upcoming' ? '–' : signedN(m.A.net)), mk('span', 'mw-vs', 'vs'), mk('span', 'mw-net' + (m.B.net > m.A.net ? ' hi' : ''), m.status === 'upcoming' ? '–' : signedN(m.B.net)));
        const top = mk('div', 'mw-top'); top.append(sideEl(m.A, false), score, sideEl(m.B, true));
        // tug-of-war bar: tips toward whoever leads
        const diff = (m.A.net - m.B.net) + (m.A.net === m.B.net ? (m.A.w - m.B.w) * 0.25 : 0);
        const pos = Math.max(8, Math.min(92, 50 + diff * 7));
        const bar = mk('div', 'mw-bar'); const fillA = mk('i', 'a'); fillA.style.width = pos + '%'; const fillB = mk('i', 'b'); fillB.style.width = (100 - pos) + '%';
        if (m.winner === m.B.owner) { fillA.className = 'b'; fillB.className = 'a'; }
        if (m.status === 'upcoming') bar.classList.add('idle');
        bar.append(fillA, fillB);
        const foot = m.status === 'upcoming' ? 'Starts ' + dayName(m.start, { weekday: 'short', month: 'short', day: 'numeric' })
          : !m.winner ? (m.status === 'final' ? 'Tie' : 'Even so far') : m.status === 'final' ? m.winner + ' wins' : m.winner + ' leads';
        const ft = mk('div', 'mw-foot'); ft.append(mk('span', null, foot), mk('span', 'mw-more', 'Details ›'));
        card.append(top, bar, ft); row.append(card);
      });
      box.append(row);
    }

    // head-to-head standings with each owner's recent matchup results
    const form = new Map(C.owners.map((o) => [o, []]));
    matchups.filter((m) => m.status === 'final').sort((a, b) => a.week - b.week).forEach((m) => {
      [m.A, m.B].forEach((sd) => form.get(sd.owner).push(!m.winner ? 't' : m.winner === sd.owner ? 'w' : 'l'));
    });
    const hb = document.querySelector('#h2h-table tbody'); hb.replaceChildren();
    h2hTable.forEach((r, i) => {
      const tr = mk('tr', [(r.w + r.t) > 0 ? medal(i + 1) : null, r.owner === me ? 'is-me' : null].filter(Boolean).join(' ') || null);
      const fd = mk('td', 'h2h-form'); const dots = mk('span', 'h2h-dots');
      const f = form.get(r.owner).slice(-4); f.forEach((x) => dots.append(mk('i', x))); for (let k = f.length; k < 4; k++) dots.append(mk('i', 'none'));
      fd.append(dots);
      const nm = mk('td', 'total', r.owner); if (r.owner === me) nm.append(mk('span', 'you-tag', 'You'));
      const netTd = mk('td', 'num'); netTd.append(mk('span', 'h2h-net ' + (r.net > 0 ? 'up' : r.net < 0 ? 'down' : 'even'), signedN(r.net)));
      tr.append(mk('td', 'rank', i + 1), nm, mk('td', 'num h2h-rec', r.t ? `${r.w}–${r.l}–${r.t}` : `${r.w}–${r.l}`),
        netTd, mk('td', 'num h2h-wins', r.wins), fd);
      hb.append(tr);
    });
  }

  // tap a matchup: both owners' games that week, day by day
  function showMatchup(m, C, slate) {
    closeBonus();
    const ov = mk('div', 'bp-overlay'); ov.id = 'bonus-pop';
    const box = mk('div', 'bp-box mx-box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', `${m.A.owner} vs ${m.B.owner}`);
    const head = mk('div', 'bp-head'); const ttl = mk('div', 'bp-title');
    ttl.append(mk('b', null, `${m.A.owner} vs ${m.B.owner}`), mk('span', null, `Week ${m.week} · ${dayName(m.start, { month: 'short', day: 'numeric' })} – ${dayName(m.end, { month: 'short', day: 'numeric' })}`));
    head.append(ttl); const x = mk('button', 'bp-close', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.addEventListener('click', closeBonus); head.append(x); box.append(head);
    const sc = mk('div', 'mx-score');
    [m.A, m.B].forEach((sd, k) => { const d = mk('div', 'mx-s' + (m.winner === sd.owner ? ' lead' : '')); d.append(mk('span', 'mx-n', sd.owner), mk('b', null, m.status === 'upcoming' ? '–' : signedN(sd.net)), mk('span', 'mx-r', `${sd.w}–${sd.l}`)); sc.append(d); if (!k) sc.append(mk('span', 'mx-vs', 'vs')); });
    box.append(sc);
    const cols = mk('div', 'mx-cols');
    [m.A, m.B].forEach((sd) => {
      const col = mk('div', 'mx-col'); const gl = ownerWeekGames(sd.owner, m, C, slate);
      const left = gl.filter((g) => g.state !== 'final').length;
      const h = mk('div', 'mx-colhead'); h.append(mk('b', null, sd.owner), mk('span', null, m.status === 'final' ? `${gl.length} games` : `${left} left of ${gl.length}`)); col.append(h);
      if (!gl.length) col.append(mk('p', 'tc-empty', 'No games found.'));
      let lastDate = null;
      gl.forEach((g) => {
        if (g.date !== lastDate) { col.append(mk('div', 'mx-day', g.date === pacificToday() ? 'Today' : dayName(g.date, { weekday: 'short', month: 'numeric', day: 'numeric' }).replace(',', ''))); lastDate = g.date; }
        const r = mk('div', 'mx-g ' + (g.state === 'final' ? (g.w ? 'win' : 'loss') : g.state));
        const tm = mk('span', 'mx-team'); tm.append(badge(g.team, 'sb-badge'), mk('b', null, abbr(g.team)), mk('span', 'mx-at', g.home ? 'vs' : '@'), mk('span', null, abbr(g.opp)));
        const rs = mk('span', 'mx-res');
        if (g.state === 'final') rs.append(mk('b', null, g.w ? 'W' : 'L'), ' ' + g.score);
        else if (g.state === 'live') rs.append(mk('b', null, '● ' + g.score), mk('small', null, ' ' + (g.detail || '')));
        else rs.textContent = g.time || '';
        if (g.both) tm.append(mk('span', 'mx-both', 'both yours'));
        r.append(tm, rs); if (g.cup) r.append(mk('span', 'tc-cup', '🏆')); col.append(r);
      });
      cols.append(col);
    });
    box.append(cols);
    ov.append(box); ov.addEventListener('click', (e) => { if (e.target === ov) closeBonus(); });
    document.body.append(ov); document.addEventListener('keydown', bonusKey); x.focus();
  }

  // ---------- an owner's games today pop-up ----------
  function showToday(owner, C, slate) {
    closeBonus();
    const all = owner == null;   // no owner = every game in the league today
    const gs = ((slate && slate.games) || []).filter((g) => all || C.owner.get(g.away) === owner || C.owner.get(g.home) === owner);
    const ov = mk('div', 'bp-overlay'); ov.id = 'bonus-pop';
    const box = mk('div', 'bp-box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', all ? "Today's games" : owner + ' games today');
    const head = mk('div', 'bp-head');
    const ttl = mk('div', 'bp-title'); ttl.append(mk('b', null, all ? "Today's games" : `${owner}'s games today`), mk('span', null, dayName(pacificToday(), { weekday: 'long', month: 'short', day: 'numeric' }))); head.append(ttl);
    const x = mk('button', 'bp-close', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.addEventListener('click', closeBonus); head.append(x);
    box.append(head);
    if (!gs.length) box.append(mk('p', 'players-msg', all ? 'No NBA games today.' : 'None of their teams play today.'));
    gs.forEach((g) => {
      const final = g.state === 'post', live = g.state === 'in';
      const card = mk('div', 'tg-game' + (live ? ' live' : '') + (g.cup ? ' cup' : ''));
      const st = mk('div', 'tg-status');
      const soon = !final && !live ? soonLabel(pacificToday(), g.time) : null;
      if (soon) card.classList.add('soon');
      st.append(mk('span', live ? 'tg-live' : soon ? 'tg-soon' : null, final ? 'FINAL' : live ? '● ' + (g.detail || 'LIVE') : soon ? `⏱ ${soon} · ${g.time}` : g.time));
      if (g.cup) st.append(mk('span', 'tg-cup', '🏆 NBA Cup'));
      card.append(st);
      const winner = final ? (g.home_score > g.away_score ? g.home : g.away) : null;
      [[g.away, g.away_score, true], [g.home, g.home_score, false]].forEach(([team, pts, away]) => {
        const mine = all || C.owner.get(team) === owner;
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

  // ---------- points race chart (Home) ----------
  // Owners keep the same color everywhere: fixed order, assigned alphabetically.
  const RACE_COLORS = { light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
                        dark:  ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'] };
  let raceData = null;
  function raceSeries(D, C) {
    const S = D.config.scoring, cupExtra = (S.cup_game_win ?? S.win) - S.win;
    const owners = [...C.owners].sort((a, b) => a.localeCompare(b));
    const start = D.config.season_start, end = C.sorted.length ? C.sorted[C.sorted.length - 1].date : start;
    const days = []; for (let d = new Date(start + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= end; d = new Date(d.getTime() + 864e5)) days.push(d.toISOString().slice(0, 10));
    const perDay = new Map(days.map((d) => [d, Object.fromEntries(owners.map((o) => [o, 0]))]));
    for (const g of C.sorted) {
      const winner = g.home_score > g.away_score ? g.home : g.away, o = C.owner.get(winner);
      if (o && perDay.has(g.date)) perDay.get(g.date)[o] += S.win + (g.cup ? cupExtra : 0);
    }
    const run = Object.fromEntries(owners.map((o) => [o, 0]));
    const pts = days.map((d) => { owners.forEach((o) => { run[o] += perDay.get(d)[o]; }); return { date: d, v: { ...run } }; });
    // non-game bonuses (playoffs, Cup title) land on the last day
    C.board.forEach((b) => { const gameBonus = C.teams.filter((t) => t.owner === b.owner).reduce((n, t) => n + t.pts_cupgames, 0); const extra = b.bonus - gameBonus; if (extra && pts.length) pts[pts.length - 1].v[b.owner] += extra; });
    return { owners, pts };
  }
  function renderRace(D, C) {
    const host = $('race'); if (!host) return;
    raceData = raceSeries(D, C);
    drawRace();
    const btn = $('race-tbl-btn');
    if (btn && !btn.dataset.wired) { btn.dataset.wired = '1'; btn.addEventListener('click', () => { const t = $('race-table'); t.hidden = !t.hidden; btn.setAttribute('aria-pressed', String(!t.hidden)); btn.textContent = t.hidden ? 'Table' : 'Chart'; host.hidden = !t.hidden; }); }
    if (!host.dataset.ro && window.ResizeObserver) { host.dataset.ro = '1'; let w0 = 0; new ResizeObserver(() => { if (Math.abs(host.clientWidth - w0) > 4) { w0 = host.clientWidth; drawRace(); } }).observe(host); }
  }
  function drawRace() {
    const host = $('race'), { owners, pts } = raceData || {}; if (!host || !pts || !pts.length) return;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches, pal = RACE_COLORS[dark ? 'dark' : 'light'];
    const color = (o) => pal[owners.indexOf(o) % pal.length];
    const W = Math.max(280, host.clientWidth), H = W < 500 ? 230 : 270;
    const lastV = pts[pts.length - 1].v, longest = Math.max(...owners.map((o) => (o + ' ' + fmt(lastV[o])).length));
    const M = { l: 30, r: 26 + longest * 7.6, t: 10, b: 24 }, iw = W - M.l - M.r, ih = H - M.t - M.b;
    const maxV = Math.max(5, ...pts.map((p) => Math.max(...owners.map((o) => p.v[o]))));
    const step = maxV <= 20 ? 5 : maxV <= 60 ? 10 : maxV <= 150 ? 25 : 50, top = Math.ceil(maxV / step) * step;
    const X = (i) => M.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw), Y = (v) => M.t + ih - (v / top) * ih;
    const NS = 'http://www.w3.org/2000/svg', el = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'race-svg', role: 'img', 'aria-label': 'Points race: total points by day for each owner' });
    for (let v = 0; v <= top; v += step) {
      svg.append(el('line', { x1: M.l, x2: M.l + iw, y1: Y(v), y2: Y(v), class: v ? 'race-grid' : 'race-base' }));
      const t = el('text', { x: M.l - 6, y: Y(v) + 3.5, class: 'race-axis', 'text-anchor': 'end' }); t.textContent = v; svg.append(t);
    }
    // date ticks: whole-day steps, evenly spaced, never closer than ~70px
    const maxTicks = Math.max(2, Math.floor(iw / 70)), every = Math.max(1, Math.ceil((pts.length - 1) / (maxTicks - 1)));
    const ticks = []; for (let i = 0; i < pts.length; i += every) ticks.push(i);
    if (ticks[ticks.length - 1] !== pts.length - 1) { if ((pts.length - 1 - ticks[ticks.length - 1]) * (iw / Math.max(1, pts.length - 1)) < 50) ticks.pop(); ticks.push(pts.length - 1); }
    ticks.forEach((i, k) => {
      const t = el('text', { x: X(i), y: H - 6, class: 'race-axis', 'text-anchor': k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'middle' });
      t.textContent = dayName(pts[i].date, { month: 'short', day: 'numeric' }); svg.append(t);
    });
    // lines, leader drawn last so it sits on top
    const me = getMe(), last = pts[pts.length - 1].v, order = owners.slice().sort((a, b) => (a === me) - (b === me) || last[a] - last[b]);
    order.forEach((o) => {
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v[o]).toFixed(1)}`).join('');
      svg.append(el('path', { d, class: 'race-line' + (me ? (o === me ? ' race-me' : ' race-dim') : ''), stroke: color(o) }));
      svg.append(el('circle', { cx: X(pts.length - 1), cy: Y(last[o]), r: 4.5, fill: color(o), class: 'race-end' }));
    });
    // end labels, nudged apart so they never overlap
    const labs = owners.map((o) => ({ o, y: Y(last[o]) })).sort((a, b) => a.y - b.y), gap = 14;
    for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < gap) labs[i].y = labs[i - 1].y + gap;
    const over = labs.length ? labs[labs.length - 1].y - (M.t + ih) : 0; if (over > 0) labs.forEach((l) => { l.y -= over; });
    labs.forEach(({ o, y }) => {
      const g = el('g', {}); g.append(el('rect', { x: M.l + iw + 9, y: y - 4, width: 8, height: 8, rx: 2, fill: color(o) }));
      const t = el('text', { x: M.l + iw + 21, y: y + 4, class: 'race-lab' + (me ? (o === me ? ' race-lab-me' : ' race-lab-dim') : '') }); t.textContent = `${o} ${fmt(last[o])}`; g.append(t); svg.append(g);
    });
    // hover crosshair + tooltip
    const cross = el('line', { y1: M.t, y2: M.t + ih, class: 'race-cross', visibility: 'hidden' }); svg.append(cross);
    const dots = owners.map((o) => { const c = el('circle', { r: 4, fill: color(o), class: 'race-dot', visibility: 'hidden' }); svg.append(c); return c; });
    const hit = el('rect', { x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent', class: 'race-hit' }); svg.append(hit);
    host.replaceChildren(svg);
    const tip = mk('div', 'race-tip'); tip.hidden = true; host.append(tip);
    const show = (cx) => {
      const r = svg.getBoundingClientRect(), x = (cx - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((x - M.l) / iw) * (pts.length - 1)))), p = pts[i];
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      owners.forEach((o, k) => { dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(p.v[o])); dots[k].setAttribute('visibility', 'visible'); });
      tip.replaceChildren(mk('div', 'race-tip-d', dayName(p.date, { weekday: 'short', month: 'short', day: 'numeric' })));
      owners.slice().sort((a, b) => p.v[b] - p.v[a]).forEach((o) => { const row = mk('div', 'race-tip-r'); const sw = mk('i'); sw.style.background = color(o); row.append(sw, mk('span', null, o), mk('b', null, fmt(p.v[o]))); tip.append(row); });
      tip.hidden = false;
      const px = (X(i) / W) * r.width, tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(r.width - tw, px + (px > r.width / 2 ? -tw - 12 : 12))) + 'px';
    };
    const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', hide);
    // table view
    const tbl = $('race-table');
    if (tbl) {
      const t = mk('table', 'race-tbl'); const hr = mk('tr'); hr.append(mk('th', null, 'Date'));
      owners.forEach((o) => hr.append(mk('th', 'num', o))); const th = mk('thead'); th.append(hr); const tb = mk('tbody');
      pts.slice().reverse().forEach((p) => { const r = mk('tr'); r.append(mk('td', 'zero', dayName(p.date, { month: 'short', day: 'numeric' }))); owners.forEach((o) => r.append(mk('td', 'num', fmt(p.v[o])))); tb.append(r); });
      t.append(th, tb); const sc = mk('div', 'scroll tall'); sc.append(t); tbl.replaceChildren(sc);
    }
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawRace());

  // ---------- team card (tap a team in Rosters) ----------
  const fmtShort = (iso) => dayName(iso, { weekday: 'short', month: 'numeric', day: 'numeric' }).replace(',', '');
  const lastName = (n) => { const p = n.split(' '); return p.length > 1 ? p[0][0] + '. ' + p.slice(1).join(' ') : n; };
  function jersey(team, num, cls) {
    const b = TEAM_BADGE[team] || ['', '#888', '#fff'];
    const j = mk('span', 'jersey' + (cls ? ' ' + cls : ''), num === '' ? '–' : String(num));
    j.style.background = b[1]; j.style.color = b[2]; return j;
  }
  function playerLink(p, text) {
    const a = mk('a', 'pp-link', text);
    a.href = 'https://www.espn.com/nba/player/_/id/' + encodeURIComponent(p.id);
    a.target = '_blank'; a.rel = 'noopener'; a.title = p.name + ' on ESPN';
    return a;
  }
  function showTeam(t, C, slate) {
    closeBonus();
    const ov = mk('div', 'bp-overlay'); ov.id = 'bonus-pop';
    const box = mk('div', 'bp-box tc-box'); box.setAttribute('role', 'dialog');
    { // team colors: a band across the top and a soft wash behind the header
      const tb = TEAM_BADGE[t.team] || ['', '#888888', '#bbbbbb'];
      const light = (h) => { const n = parseInt(h.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 225; };
      box.style.setProperty('--tc1', tb[1]);
      box.style.setProperty('--tc2', light(tb[2]) ? `color-mix(in srgb, ${tb[1]} 55%, #000)` : tb[2]);
      box.classList.add('tc-colored');
    } box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', t.team + ' team card');
    // header
    const head = mk('div', 'tc-head');
    head.append(badge(t.team, 'badge tc-badge'));
    const ttl = mk('div', 'bp-title tc-title'); ttl.append(mk('b', null, t.team), mk('span', null, t.owner + "'s team"));
    const pts = mk('div', 'tc-pts', fmt(t.points)); pts.append(mk('small', null, t.points === 1 ? 'pt' : 'pts'));
    const x = mk('button', 'bp-close', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.addEventListener('click', closeBonus);
    head.append(ttl, pts, x); box.append(head);
    // record / pace / projection
    const tiles = mk('div', 'tc-tiles');
    const tile = (label, value, cls, sub) => { const d = mk('div', 'tc-tile'); d.append(mk('span', 'tc-tl', label), mk('b', cls || null, value)); if (sub) d.append(mk('span', 'tc-ts ' + (cls || ''), sub)); tiles.append(d); };
    tile('Record', `${t.wins}–${t.losses}`);
    const diff = t.pace != null && t.proj != null ? Math.round((t.pace - t.proj) * 10) / 10 : null;
    tile('Win pace', t.pace == null ? '–' : t.pace.toFixed(1), paceClass(t.pace, t.proj), diff == null ? '' : (diff > 0 ? '+' : diff < 0 ? '−' : '±') + Math.abs(diff).toFixed(1) + ' vs line');
    tile('Preseason line', t.proj ?? '–');
    if (t.bonus) tile('Bonus pts', '+' + t.bonus, 'up');
    box.append(tiles);
    // last 5 / next 5
    const games = mk('div', 'tc-games');
    const col = (title) => { const c = mk('div', 'tc-col'); const h = mk('div', 'tc-colhead'); h.append(mk('h4', 'tc-h', title)); c.append(h); games.append(c); return c; };
    const wk1 = Date.parse(D.config.week1_monday + 'T00:00:00Z');
    const weekOf = (iso) => Math.floor((Date.parse(iso + 'T00:00:00Z') - wk1) / 864e5 / 7) + 1;
    const weekBreak = (c, w) => { const d = mk('div', 'tc-week'); d.append(mk('span', null, 'Week ' + w)); c.append(d); };
    const prevDay = (iso) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
    const teamName = (x) => mk('span', 'tc-oname', abbr(x));
    const fullName = (x) => mk('span', 'tc-ofull', short(x));
    const oppEl = (home, o) => { const e = mk('span', 'tc-opp'); e.append(mk('span', 'tc-at', home ? 'vs' : '@'), badge(o, 'sb-badge tc-obadge'), teamName(o), fullName(o)); return e; };
    // Last 5
    const last = col('Last 5'), lg = t.last5g;
    if (lg.length) {
      // streak strip, oldest -> newest, plus current streak and record
      const strip = mk('div', 'tc-streak');
      const sq = mk('span', 'tc-sq'); lg.forEach((g) => { const b = mk('i', g.w ? 'w' : 'l'); b.title = `${fmtShort(g.date)}: ${g.w ? 'W' : 'L'} ${g.score.replace('-', '–')}`; sq.append(b); });
      for (let k = lg.length; k < 5; k++) sq.append(mk('i', 'none'));
      let n = 0; const lw = lg[lg.length - 1].w; for (let k = lg.length - 1; k >= 0 && lg[k].w === lw; k--) n++;
      const wins = lg.filter((g) => g.w).length;
      const lab = mk('span', 'tc-slab'); lab.append(mk('b', lw ? 'up' : 'down', (lw ? 'W' : 'L') + n), ` · ${wins}–${lg.length - wins} last ${lg.length}`);
      strip.append(sq, lab); last.firstChild.append(strip);
    } else last.append(mk('p', 'tc-empty', 'No games yet.'));
    lg.forEach((g, k, arr) => {   // oldest at the top, most recent at the bottom
      if (k && weekOf(g.date) !== weekOf(arr[k - 1].date)) weekBreak(last, weekOf(g.date));
      const [a, b] = g.score.split('-').map(Number), m = a - b;
      const r = mk('div', 'tc-g tc-res-row ' + (g.w ? 'win' : 'loss'));
      const res = mk('span', 'tc-res ' + (g.w ? 'win' : 'loss')); res.append(mk('b', null, g.w ? 'W' : 'L'), ' ' + g.score.replace('-', '–'));
      const meta = mk('span', 'tc-meta'); meta.append(mk('span', 'tc-margin ' + (m > 0 ? 'up' : 'down'), (m > 0 ? '+' : '−') + Math.abs(m)));
      const older = arr[k - 1]; if (older && older.date === prevDay(g.date)) meta.append(mk('span', 'tc-b2b', 'B2B'));
      if (g.cup) meta.append(mk('span', 'tc-cup', '🏆'));
      r.append(mk('span', 'tc-date', fmtShort(g.date)), oppEl(g.home, g.opp), res, meta); last.append(r);
    });
    // Next 5 (tonight's game, live or not, goes first and stands out)
    const next = col('Next 5');
    const today = pacificToday();
    const liveG = ((slate && slate.games) || []).find((g) => (g.away === t.team || g.home === t.team) && g.state === 'in');
    const up = nextGames(t.team, liveG ? 4 : 5);
    const rows = (liveG ? [{ ...liveG, date: today, live: true }] : []).concat(up);
    if (!rows.length) next.append(mk('p', 'tc-empty', D.schedule ? 'No games scheduled.' : 'Schedule coming soon.'));
    let prev = lg.length ? lg[lg.length - 1].date : null;
    let lastWk = weekOf(today);
    rows.forEach((g) => {
      if (weekOf(g.date) !== lastWk) { lastWk = weekOf(g.date); weekBreak(next, lastWk); }
      const home = g.home === t.team, o = home ? g.away : g.home, isToday = g.date === today;
      const r = mk('div', 'tc-g' + (isToday ? ' tc-tonight' : '') + (g.live ? ' is-live' : ''));
      const soonT = !g.live && isToday ? soonLabel(g.date, g.time) : null;
      const when = mk('span', 'tc-date' + (soonT ? ' tc-soon' : '')); when.textContent = g.live ? '● Live' : soonT || (isToday ? 'Tonight' : fmtShort(g.date));
      const right = mk('span', 'tc-time');
      if (g.live) { const mine = home ? g.home_score : g.away_score, theirs = home ? g.away_score : g.home_score; right.append(mk('b', mine >= theirs ? 'up' : 'down', `${mine}–${theirs}`), mk('small', 'tc-clock', g.detail || '')); }
      else {
        right.append(mk('span', null, g.time || ''));
        // moneyline for this team: saved pregame line first, then the schedule's
        const ln = C.lineOf.get(g.date + '|' + g.away + '|' + g.home) || g;
        const v = home ? ln.home_ml : ln.away_ml;
        if (v != null && !isNaN(v)) right.append(mk('small', 'tc-ml ' + (v < 0 ? 'fav' : 'dog'), 'ML ' + ml(v)));
      }
      const meta = mk('span', 'tc-meta'); if (prev && prev === prevDay(g.date)) meta.append(mk('span', 'tc-b2b', 'B2B'));
      if (g.cup) meta.append(mk('span', 'tc-cup', '🏆'));
      r.append(when, oppEl(home, o), right, meta); next.append(r); prev = g.date;
    });
    box.append(games);
    // roster
    const ros = mk('div', 'tc-roster'); ros.append(mk('p', 'players-msg', 'Loading roster…')); box.append(ros);
    ov.append(box);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeBonus(); });
    document.body.append(ov); document.addEventListener('keydown', bonusKey); x.focus();
    fetchPlayers(t.team).then(({ players: ps, hasDepth }) => {
      ros.replaceChildren();
      if (!ps.length) { ros.append(mk('p', 'players-msg', 'No roster found.')); return; }
      const v = (p, k) => (p.s && p.s[k] != null ? p.s[k] : '–');
      const starters = hasDepth ? ps.filter((p) => p.starter) : [];
      const bench = hasDepth ? ps.filter((p) => !p.starter) : ps;
      if (starters.length) {
        ros.append(mk('h4', 'tc-h', 'Starting five'));
        const row = mk('div', 'tc-five');
        starters.forEach((p) => {
          const c = mk('div', 'tc-p' + (p.out ? ' is-out' : ''));
          c.append(jersey(t.team, p.num, 'jersey-lg'), mk('span', 'tc-pos', p.spot));
          const nm = mk('div', 'tc-pname'); nm.append(playerLink(p, lastName(p.name))); c.append(nm);
          if (p.out) c.append(mk('span', 'pp-out tc-outtag', /day/i.test(p.out) ? 'DTD' : p.out));
          const st = mk('div', 'tc-pstats');
          [['PTS', 'avgPoints'], ['REB', 'avgRebounds'], ['AST', 'avgAssists']].forEach(([l, k]) => { const s1 = mk('div', 'tc-ps'); s1.append(mk('b', null, v(p, k)), mk('span', null, l)); st.append(s1); });
          c.append(st); row.append(c);
        });
        ros.append(row);
      }
      ros.append(mk('h4', 'tc-h', starters.length ? 'Bench' : 'Roster'));
      const tb = mk('table', 'tc-bench'); const hr = mk('tr');
      [['Player', ''], ['Pos', ''], ['MIN', 'num'], ['PTS', 'num'], ['REB', 'num'], ['AST', 'num']].forEach(([l, c]) => hr.append(mk('th', c, l)));
      const thd = mk('thead'); thd.append(hr); const tbd = mk('tbody');
      bench.forEach((p) => {
        const r = mk('tr', p.out ? 'is-out' : null);
        const nm = mk('td', 'tc-bname'); const inner = mk('div', 'tc-bin'); inner.append(jersey(t.team, p.num), playerLink(p, lastName(p.name)));
        if (p.out) inner.append(mk('span', 'pp-out', /day/i.test(p.out) ? 'DTD' : p.out)); nm.append(inner);
        r.append(nm, mk('td', 'tc-bpos', p.spot), mk('td', 'num dim', v(p, 'avgMinutes')), mk('td', 'num strong', v(p, 'avgPoints')), mk('td', 'num', v(p, 'avgRebounds')), mk('td', 'num', v(p, 'avgAssists')));
        tbd.append(r);
      });
      tb.append(thd, tbd); ros.append(tb);
      ros.append(mk('p', 'players-foot', 'Season averages per game · Lineup from ESPN’s depth chart · Tap a player for their ESPN page'));
    }).catch(() => { ros.replaceChildren(mk('p', 'players-msg', 'Couldn’t load the roster right now. Try again in a minute.')); playerCache.delete(t.team); });
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
  // ---------- phones: swipe a sheet down to close it, like iOS ----------
  function enableSwipe(ov) {
    const box = ov.querySelector('.bp-box'); if (!box || !matchMedia('(max-width: 600px)').matches) return;
    let y0 = null, dy = 0, t0 = 0, dragging = false;
    const start = (e) => {
      const t = e.touches ? e.touches[0] : e; const r = box.getBoundingClientRect();
      // drag from the grab-handle area, or anywhere once the sheet is scrolled to the top
      if (t.clientY - r.top > 44 && box.scrollTop > 0) return;
      y0 = t.clientY; dy = 0; t0 = Date.now(); dragging = false;
    };
    const move = (e) => {
      if (y0 == null) return; const t = e.touches ? e.touches[0] : e; dy = t.clientY - y0;
      if (!dragging) { if (dy > 6 && box.scrollTop <= 0) { dragging = true; box.style.transition = 'none'; } else if (dy < -4) { y0 = null; return; } else return; }
      e.preventDefault();
      const d = Math.max(0, dy); box.style.transform = `translateY(${d}px)`; ov.style.background = `rgba(0,0,0,${Math.max(0, .35 - d / 900)})`;
    };
    const end = () => {
      if (y0 == null) return; const fast = dy / Math.max(1, Date.now() - t0) > 0.6; y0 = null;
      if (!dragging) return;
      box.style.transition = 'transform .22s ease';
      if (dy > 110 || (fast && dy > 30)) { box.style.transform = 'translateY(100%)'; ov.style.transition = 'opacity .22s ease'; ov.style.opacity = '0'; setTimeout(closeBonus, 210); }
      else { box.style.transform = ''; ov.style.background = ''; }
      dragging = false;
    };
    box.addEventListener('touchstart', start, { passive: true });
    box.addEventListener('touchmove', move, { passive: false });
    box.addEventListener('touchend', end); box.addEventListener('touchcancel', end);
  }
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.id === 'bonus-pop') enableSwipe(n); }))).observe(document.body, { childList: true });

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

  const prevScores = new Map();
  function renderStrip(slate, C) {
    const strip = $('sb-strip'); strip.replaceChildren();
    const date = slate.date || pacificToday();
    $('sb-date').querySelector('.sb-dow').textContent = dayName(date, { weekday: 'short' }).toUpperCase();
    $('sb-date').querySelector('.sb-md').textContent = dayName(date, { month: 'short', day: 'numeric' }).toUpperCase();
    if (!slate.games.length) { strip.append(mk('div', 'sb-none', 'No games today')); return; }
    const me = getMe(), mineG = (g) => C.owner.get(g.away) === me || C.owner.get(g.home) === me;
    slate.games.slice().sort((a, b) => (me ? mineG(b) - mineG(a) : 0)).forEach((g) => {
      const final = g.state === 'post', live = g.state === 'in';
      const card = mk('div', 'sb-card ' + (final ? 'final' : live ? 'live' : 'pre') + (g.cup ? ' cup' : '') + (me && mineG(g) ? ' is-me' : ''));
      const ln = C.lineOf.get(date + '|' + g.away + '|' + g.home);
      const st = mk('div', 'sb-status');
      const soon = !final && !live ? soonLabel(date, g.time) : null;
      if (soon) card.classList.add('soon');
      st.append(mk('span', soon ? 'sb-soon' : null, final ? 'FINAL' : live ? (g.detail || 'LIVE') : soon || g.time));
      if (ln && ln.fav && ln.spread != null) st.append(mk('span', 'sb-line', ln.spread === 0 ? 'PK' : (TEAM_BADGE[ln.fav] || [short(ln.fav)])[0] + ' −' + ln.spread));
      card.append(st);
      const winner = final ? (g.home_score > g.away_score ? g.home : g.away) : null;
      [[g.away, g.away_score, ln && ln.away_ml], [g.home, g.home_score, ln && ln.home_ml]].forEach(([team, pts, line]) => {
        const row = mk('div', 'sb-row' + (final ? (team === winner ? ' won-row' : ' lost-row') : ''));
        const nm = mk('span', 'sb-team'); nm.append(mk('span', 'sb-name', short(team)), mk('span', 'sb-owner', C.owner.get(team) || ''));
        const key = g.id + '|' + team, ptsEl = final || live ? mk('span', 'sb-pts', pts ?? '') : null;
        if (ptsEl) { const was = prevScores.get(key); if (was != null && was !== pts) ptsEl.classList.add('score-pop'); prevScores.set(key, pts); }
        row.append(badge(team, 'sb-badge'), nm, ptsEl || mk('span', 'sb-ml', ml(line)), mk('span', 'sb-arrow', team === winner ? '◂' : ''));
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
    // only the More tab's sections fold up; Home, Matchups and Rosters always stay open
    const FOLDABLE = ['bonus-card', 'rules-card', 'upset-card', 'ideas-card'];
    const sections = [...document.querySelectorAll('section.card')].filter((c) => FOLDABLE.includes(c.id) && c.querySelector(':scope > h2'))
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
      home: ['scoreboard', 'me-card', 'leaderboard-card', 'race-card', 'recap-card', 'results-card'],
      matchups: ['matchups-card'],
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

  // ---------- slim title bar pinned to the top once the big header scrolls away (phones) ----------
  (function pinnedTitle() {
    const head = document.querySelector('.pl-head'), mini = document.getElementById('pl-mini');
    if (!head || !mini || !window.IntersectionObserver) return;
    new IntersectionObserver(([e]) => { mini.classList.toggle('show', !e.isIntersecting); }, { rootMargin: '-8px 0px 0px 0px' }).observe(head);
    mini.querySelector('a').addEventListener('click', (ev) => { ev.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  })();

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
