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
      if (log.has(g.home)) log.get(g.home).push({ date: g.date, opp: g.away, w: homeWon, score: `${g.home_score}-${g.away_score}` });
      if (log.has(g.away)) log.get(g.away).push({ date: g.date, opp: g.home, w: !homeWon, score: `${g.away_score}-${g.home_score}` });
    }

    const teams = rosters.map((r) => {
      const L = log.get(r.team) || [];
      const w = L.filter((x) => x.w).length, l = L.length - w;
      const b = bon.get(r.team) || {};
      const pts_playoffs = b.made_playoffs ? S.made_playoffs : 0;
      const pts_pw = (Number(b.playoff_wins) || 0) * S.playoff_win;
      const pts_cup = b.won_cup ? S.won_cup : 0;
      const pre = proj.get(r.team);
      const g = w + l;
      const rate = (w + 20 * (pre / 82)) / (g + 20);
      const pace = pre == null ? null : Math.round((w + (82 - g) * rate) * 10) / 10;
      const bonus = pts_playoffs + pts_pw + pts_cup;
      return { team: r.team, owner: r.owner, wins: w, losses: l, proj: pre, pace, last5: L.slice(-5).map((x) => (x.w ? 'W' : 'L')),
        made: b.made_playoffs ? 1 : 0, playoff_wins: Number(b.playoff_wins) || 0, pts_playoffs, pts_pw, pts_cup, bonus,
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
      const lastWeek = Math.max(curWeek + 1, M.start_week);  // show one week ahead
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
    board.forEach((b, i) => { b.rank = i + 1; b.behind = board[0].points - b.points; });

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
        return { id: String(ev.id), state: st.state, detail: st.shortDetail || '', season_type: (ev.season || {}).type,
          time: new Date(ev.date).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }),
          away: nm(a), home: nm(h), away_score: st.state === 'pre' ? null : Number(a.score), home_score: st.state === 'pre' ? null : Number(h.score) };
      });
    } catch (e) { return null; }
  }

  // ---------- rendering ----------
  function render(D, C, slate) {
    const { board, teams, weekly, upsets, owner } = C;

    // takeaway
    const take = $('takeaway'); take.replaceChildren();
    if (board.length) {
      const [a, b] = board;
      take.append(mk('b', null, a.owner), ' leads with ', mk('b', null, fmt(a.points)), ' points');
      if (b) take.append(b.behind === 0 ? ', tied with ' + b.owner + '.' : ', ' + b.behind + ' ahead of ' + b.owner + '.');
    }

    // leaderboard
    const lb = document.querySelector('#leaderboard tbody'); lb.replaceChildren();
    const max = Math.max(1, ...board.map((d) => d.points));
    board.forEach((d, i) => {
      const tr = mk('tr', i === 0 && d.points > 0 ? 'lead' : null);
      const bar = mk('div', 'bar');
      const w = mk('span'); w.style.width = (d.wins / max * 100) + '%';
      const bo = mk('span'); bo.style.width = (d.bonus / max * 100) + '%';
      bar.append(w, bo);
      const bc = mk('td', 'barcell hide-sm'); bc.append(bar);
      tr.append(mk('td', 'rank', d.rank), mk('td', 'total', d.owner), mk('td', 'num', fmt(d.wins)), mk('td', 'num' + (d.bonus ? '' : ' zero'), fmt(d.bonus)),
        mk('td', 'num total', fmt(d.points)), mk('td', 'num', d.this_week), mk('td', 'num hide-sm' + (d.weeks_won ? '' : ' zero'), d.weeks_won),
        mk('td', 'num hide-sm zero', d.behind), bc);
      lb.append(tr);
    });

    renderMatchups(C);

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
      ['Week leader', cur ? cur.winners.join(' & ') || '—' : '—', cur ? cur.best + ' wins this week' : ''],
      ['Hottest team', hot ? hot.team : '—', hot ? teamWeek.get(hot.team) + ' wins this week · ' + hot.owner : ''],
      ['Biggest overachiever', up ? up.team : '—', up ? 'Win pace ' + sign(diff(up)) + ' vs preseason · ' + up.owner : ''],
      ['Biggest letdown', down ? down.team : '—', down ? 'Win pace ' + sign(diff(down)) + ' vs preseason · ' + down.owner : ''],
    ];
    const rc = $('recap'); rc.replaceChildren();
    tiles.forEach(([l, n, d]) => { const t = mk('div', 'tile'); t.append(mk('div', 'tile-label', l), mk('div', 'tile-name', n), mk('div', 'tile-detail', d)); rc.append(t); });

    // last night's results
    const today = slate.date || pacificToday();
    const prior = C.sorted.filter((g) => g.date < today);
    const lastDay = prior.length ? prior[prior.length - 1].date : null;
    const res = prior.filter((g) => g.date === lastDay);
    const rb = document.querySelector('#results-table tbody'); rb.replaceChildren();
    $('results-empty').hidden = res.length > 0;
    if (lastDay) $('results-date').textContent = fmtDay(lastDay) + ' · winners keep their colors; the owner who picked up the win gets +1.';
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
    const order = ['Lucas', 'Parker', 'Rahul', 'Darin', 'Dom', 'OJ'].filter((o) => C.owners.includes(o)).concat(C.owners.filter((o) => !['Lucas', 'Parker', 'Rahul', 'Darin', 'Dom', 'OJ'].includes(o)));
    order.forEach((o) => {
      const row = board.find((b) => b.owner === o);
      const card = mk('section', 'card'); card.id = 'owner-' + o.toLowerCase();
      const head = mk('div', 'owner-head');
      const nameBox = mk('div'); nameBox.append(mk('h2', null, o));
      const pl = mk('div', 'projline', 'Preseason proj. wins: ');
      pl.append(mk('b', null, row.proj), ' · Win pace*: ');
      pl.append(mk('b', paceClass(row.pace, row.proj), row.pace.toFixed(1)));
      nameBox.append(pl);
      const pts = mk('div', 'owner-pts', fmt(row.points)); pts.append(mk('small', null, 'pts'));
      head.append(nameBox, pts);
      card.append(head, mk('p', 'note', `Rank ${row.rank} of ${board.length}`));
      const tb = mk('table', 'teams');
      const th = mk('thead'); const htr = mk('tr');
      [['Team', ''], ['W', 'num'], ['L', 'num'], ['Preseason proj. wins', 'num'], ['Win pace*', 'num'], ['Pts', 'num']].forEach(([t, c]) => htr.append(mk('th', c, t)));
      th.append(htr); tb.append(th);
      const body = mk('tbody');
      teams.filter((t) => t.owner === o).sort((a, b) => b.points - a.points || a.team.localeCompare(b.team)).forEach((t) => {
        const tr = mk('tr');
        const name = mk('td', null, short(t.team));
        const l5 = mk('div', 'l5'); t.last5.forEach((r) => l5.append(mk('span', r === 'W' ? 'w' : 'l'))); l5.title = 'Last 5, oldest to newest: ' + t.last5.join(' ');
        name.append(l5);
        tr.append(name, mk('td', 'num', t.wins), mk('td', 'num zero', t.losses), mk('td', 'num zero', t.proj ?? ''),
          mk('td', 'num ' + paceClass(t.pace, t.proj), t.pace == null ? '' : t.pace.toFixed(1)), mk('td', 'num total', t.points));
        body.append(tr);
      });
      tb.append(body); card.append(tb); og.append(card);
    });

    // bonuses
    const bb = document.querySelector('#bonus-table tbody'); bb.replaceChildren();
    const withB = teams.filter((t) => t.bonus > 0).sort((a, b) => b.bonus - a.bonus);
    $('bonus-empty').hidden = withB.length > 0; $('bonus-table').hidden = withB.length === 0;
    withB.forEach((t) => {
      const tr = mk('tr');
      tr.append(mk('td', null, short(t.team)), mk('td', null, t.owner), mk('td', 'num', t.pts_playoffs), mk('td', 'num', t.playoff_wins), mk('td', 'num', t.pts_pw), mk('td', 'num', t.pts_cup), mk('td', 'num total', t.bonus));
      bb.append(tr);
    });

    // upset watch
    const ut = document.querySelector('#upset-tally tbody'); ut.replaceChildren();
    C.owners.map((o) => {
      const m = upsets.filter((u) => u.owner === o);
      return { o, u: m.filter((x) => x.pts === 1).length, b: m.filter((x) => x.pts === 2).length, s: m.filter((x) => x.pts === 3).length,
        pts: m.reduce((a, x) => a + x.pts, 0), longest: m.length ? Math.max(...m.map((x) => x.ml)) : null };
    }).sort((a, b) => b.pts - a.pts || (b.longest || 0) - (a.longest || 0) || a.o.localeCompare(b.o)).forEach((d) => {
      const tr = mk('tr'); const c = (n) => mk('td', 'num' + (n ? '' : ' zero'), n);
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

  function renderMatchups(C) {
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
          line.append(mk('span', 'mu-owner', s.owner), mk('span', 'mu-rec', `${s.w}–${s.l}`), mk('span', 'mu-net' + (s.net < 0 ? ' neg' : ''), signed(s.net)));
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
      const tr = mk('tr', i === 0 && (r.w + r.t) > 0 ? 'lead' : null);
      tr.append(mk('td', 'rank', i + 1), mk('td', 'total', r.owner), mk('td', 'num total', r.t ? `${r.w}–${r.l}–${r.t}` : `${r.w}–${r.l}`),
        mk('td', 'num' + (r.net > 0 ? ' up' : r.net < 0 ? ' down' : ' zero'), signed(r.net)), mk('td', 'num zero', r.wins));
      hb.append(tr);
    });

    const sb = document.querySelector('#mu-sched tbody'); sb.replaceChildren();
    matchups.slice().sort((a, b) => b.week - a.week).forEach((m) => {
      const tr = mk('tr', m.status === 'live' ? 'lead' : null);
      const res = m.status === 'upcoming' ? '—'
        : `${m.A.w}–${m.A.l} vs ${m.B.w}–${m.B.l}` + (m.status === 'final' ? (m.winner ? ' · ' + m.winner : ' · Tie') : ' · live');
      const who = mk('td');
      const a = mk('span', m.status === 'final' && m.winner === m.A.owner ? 'total' : m.status === 'final' && m.winner ? 'zero' : null, m.A.owner);
      const b = mk('span', m.status === 'final' && m.winner === m.B.owner ? 'total' : m.status === 'final' && m.winner ? 'zero' : null, m.B.owner);
      who.append(a, ' vs ', b);
      tr.append(mk('td', 'zero', m.week), who, mk('td', 'num' + (m.status === 'upcoming' ? ' zero' : ''), res));
      sb.append(tr);
    });
  }

  function paceClass(pace, pre) { return pace == null || pre == null || pace === pre ? 'zero' : pace > pre ? 'up' : 'down'; }

  function sideEl(team, ownerName, state) {
    const wrap = mk('div', 'side' + (state ? ' ' + state : ''));
    const o = mk('div', 'side-owner', ownerName || '—');
    if (state === 'won') o.append(mk('span', 'plus', '+1'));
    wrap.append(badge(team, 'badge'), o);
    return wrap;
  }
  function resultRow(g, owner) {
    const awayWon = g.away_score > g.home_score;
    const row = mk('div', 'matchup');
    const sc = mk('div', 'score');
    sc.append(mk('span', awayWon ? 'hi' : null, g.away_score), mk('span', null, '–'), mk('span', awayWon ? null : 'hi', g.home_score));
    row.append(sideEl(g.away, owner.get(g.away), awayWon ? 'won' : 'lost'), sc, sideEl(g.home, owner.get(g.home), awayWon ? 'lost' : 'won'));
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
      const card = mk('div', 'sb-card ' + (final ? 'final' : live ? 'live' : 'pre'));
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
      const foot = final ? (C.owner.get(winner) || '') + ' +1' : ao === ho ? ho + ' wins either way' : `${ao || '—'} vs ${ho || '—'}`;
      card.append(mk('div', 'sb-foot', foot));
      strip.append(card);
    });
  }

  // ---------- boot ----------
  let D, slate;
  async function load() {
    const names = ['rosters', 'projections', 'games', 'lines', 'bonuses', 'config', 'today', 'meta'];
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
          D.games.push({ id: g.id, date: slate.date, away: g.away, home: g.home, away_score: g.away_score, home_score: g.home_score });
        }
      }
    }
    render(D, compute(D), slate);
  }

  (async () => {
    try {
      await load();
      render(D, compute(D), slate);
      await refreshLive();
      setInterval(refreshLive, 60 * 1000);
      setInterval(async () => { await load(); await refreshLive(); }, 10 * 60 * 1000);
    } catch (e) {
      console.error(e);
      $('takeaway').textContent = 'Couldn’t load the league data. Try refreshing in a minute.';
    }
  })();
})();
