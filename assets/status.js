// Viremail status page. No frameworks, no third parties, no cookies.
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const meta = (n) => (document.querySelector(`meta[name="${n}"]`) || {}).content;
  const REPO = meta('status-repo');
  const BRANCH = meta('status-branch') || 'main';
  // On the real site, read results straight from the repository so they are fresh even when
  // the page itself has not been rebuilt. Anywhere else (a local copy), use the files next to it.
  const LIVE = /(^|\.)viremail\.com$|\.github\.io$/.test(location.hostname);
  const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/data/`;
  const API = `https://api.github.com/repos/${REPO}`;
  const ISSUES = `https://github.com/${REPO}/issues?q=label%3Aincident%2Cmaintenance`;
  const MIN = 60000;
  const DAY = 24 * 60 * MIN;
  const MINOR_LIMIT = 15; // minutes of problems in a day before a bar turns red
  const STALE = 2 * 60 * MIN;
  const REFRESH = 5 * MIN;
  const NOTICE_CACHE = 2 * MIN;
  const SHORT_DAYS = 45; // bars shown on narrow screens
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
  const BOT = 'github-actions[bot]';

  const state = { cur: null, up: null, resp: null, notices: null, noticeNote: '', loadedAt: 0 };

  // Icons: a filled circle with a symbol, so state never rests on colour alone.
  const INNER = {
    ok: '<path d="M7.2 12.4l3.2 3.2L16.8 9"/>',
    minor: '<path d="M12 7v6"/><path d="M12 16.8v.01"/>',
    major: '<path d="M8.6 8.6l6.8 6.8"/><path d="M15.4 8.6l-6.8 6.8"/>',
    info: '<path d="M12 11v6"/><path d="M12 7.3v.01"/>',
    unknown: '<path d="M8 12h8"/>',
  };
  const icon = (s) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><g class="ic-in">${INNER[s] || INNER.unknown}</g></svg>`;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = (n) => String(n).padStart(2, '0');
  const tz = (() => {
    try {
      const p = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' }).formatToParts(new Date());
      return (p.find((x) => x.type === 'timeZoneName') || {}).value || '';
    } catch { return ''; }
  })();
  const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const date = (ms, withYear) => {
    const d = new Date(ms);
    const y = withYear || d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
    return `${d.getDate()} ${MONTHS[d.getMonth()]}${y}`;
  };
  const dateTime = (ms) => `${date(ms)}, ${clock(ms)}`;
  const utcDate = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / MIN);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  function duration(mins) {
    const m = Math.max(1, Math.round(mins));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  }

  // Storage is only a cache of public data; the page works the same without it.
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  async function getJson(name) {
    const urls = LIVE ? [RAW + name, 'data/' + name] : ['data/' + name];
    for (const u of urls) {
      try {
        const r = await fetch(u, { cache: 'no-cache' });
        if (r.ok) return await r.json();
      } catch {}
    }
    throw new Error(`Could not load ${name}`);
  }

  // ---------- Results ----------

  function groupView(g) {
    const { cur } = state;
    const checks = g.checks.filter((id) => cur.checks[id]).map((id) => ({ id, name: cur.names[id] || id, ...cur.checks[id] }));
    const failing = checks.filter((c) => !c.ok);
    const open = (state.notices || []).filter((n) => n.open && n.groups.includes(g.id));
    let s = 'ok';
    let label = 'Working';
    if (!checks.length) { s = 'unknown'; label = 'No data'; }
    else if (failing.length === checks.length) { s = 'major'; label = 'Down'; }
    else if (failing.length) { s = 'minor'; label = 'Some problems'; }
    else if (open.some((n) => n.kind === 'incident')) { s = 'minor'; label = 'Incident open'; }
    else if (open.length) { s = 'info'; label = 'Maintenance'; }
    return { g, checks, failing, s, label };
  }

  function groupDays(g) {
    const { up } = state;
    const from = Date.parse(up.from + 'T00:00:00Z');
    const days = [];
    for (let i = 0; i < 90; i++) {
      let total = 0;
      let down = 0;
      const per = [];
      for (const id of g.checks) {
        const cell = up.checks[id] && up.checks[id][i];
        if (!cell) continue;
        total = Math.max(total, cell[1]);
        down = Math.max(down, cell[0]);
        if (cell[0] > 0) per.push([id, cell[0]]);
      }
      const level = !total ? 'none' : down === 0 ? 'ok' : down < MINOR_LIMIT ? 'minor' : 'major';
      days.push({ t: from + i * DAY, total, down, per, level });
    }
    return days;
  }

  function uptimeText(days) {
    const withData = days.filter((d) => d.total > 0);
    if (!withData.length) return { text: 'No data yet', since: null };
    const total = withData.reduce((a, d) => a + d.total, 0);
    const down = withData.reduce((a, d) => a + d.down, 0);
    const p = Math.floor((1 - down / total) * 10000) / 100;
    const text = `${p === 100 ? '100' : p.toFixed(2)}% uptime`;
    return { text, since: withData[0].t !== days[0].t ? withData[0].t : null };
  }

  function dayTip(d, i) {
    const title = i === 89 ? `Today, ${utcDate(d.t)}` : utcDate(d.t);
    if (d.level === 'none') return `<b>${title}</b><div class="t-row">No data for this day.</div>`;
    if (d.level === 'ok') return `<b>${title}</b><div class="t-row">No problems${i === 89 ? ' so far' : ''}.</div>`;
    const rows = d.per.map(([id, m]) => `<div class="t-row">${esc(state.cur.names[id] || id)}: ${duration(m)}</div>`).join('');
    return `<b>${title}</b><div class="t-row">Problems for about ${duration(d.down)}.</div>${rows}`;
  }

  function sparkData(id) {
    const { resp } = state;
    const vals = (resp.ms && resp.ms[id]) || [];
    return (resp.t || []).map((s, i) => ({ t: s * 1000, v: vals[i] ?? null }));
  }

  function median(nums) {
    const a = nums.slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }

  function sparkSvg(pts) {
    const W = 300;
    const H = 40;
    const vals = pts.map((p) => p.v).filter((v) => v != null);
    const max = Math.max(...vals, 1) * 1.15;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const x = (t) => (t1 === t0 ? W : ((t - t0) / (t1 - t0)) * W);
    const y = (v) => H - (v / max) * (H - 2);
    let line = '';
    let area = '';
    let seg = [];
    const flush = () => {
      if (!seg.length) return;
      if (seg.length === 1) seg.push({ t: seg[0].t, v: seg[0].v, solo: true });
      const d = seg.map((p, i) => `${i ? 'L' : 'M'}${(x(p.t) + (p.solo ? 1.5 : 0)).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
      line += d;
      area += `${d}L${(x(seg[seg.length - 1].t) + (seg[seg.length - 1].solo ? 1.5 : 0)).toFixed(1)} ${H}L${x(seg[0].t).toFixed(1)} ${H}Z`;
      seg = [];
    };
    let miss = '';
    for (const p of pts) {
      if (p.v == null) { flush(); miss += `<line class="spark-miss" x1="${x(p.t).toFixed(1)}" x2="${x(p.t).toFixed(1)}" y1="${H - 9}" y2="${H}"/>`; }
      else seg.push(p);
    }
    flush();
    return {
      svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
        `<line class="spark-base" x1="0" x2="${W}" y1="${H}" y2="${H}"/>` +
        `<path class="spark-area" d="${area}"/><path class="spark-line" d="${line}"/>${miss}` +
        `<line class="spark-x" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/></svg>`,
      pos: (p) => ({ x: x(p.t) / W, y: p.v == null ? 1 : y(p.v) / H }),
    };
  }

  function renderGroups() {
    const { cur } = state;
    const html = cur.groups.map((g, gi) => {
      const v = groupView(g);
      const days = groupDays(g);
      const up = uptimeText(days);
      const bad = days.filter((d) => d.level === 'minor' || d.level === 'major');
      const sinceText = up.since ? ` since ${date(up.since, true)}` : ' over 90 days';
      const summary = `${g.name}, daily results. ${up.text}${sinceText}. ` +
        (bad.length ? `${bad.length} day${bad.length === 1 ? '' : 's'} with problems.` : 'No days with problems.');
      const pts = sparkData(g.spark);
      const vals = pts.map((p) => p.v).filter((x) => x != null);
      const last = pts.length ? pts[pts.length - 1].v : null;
      const med = median(vals);
      const sparkName = cur.names[g.spark] || g.spark;
      const sparkLabel = pts.length
        ? `Response time of ${sparkName}. Latest ${last != null ? last + ' ms' : 'check failed'}, median ${med ?? 'unknown'} ms, over ${pts.length} saved check${pts.length === 1 ? '' : 's'} since ${dateTime(pts[0].t)}.`
        : 'No response times yet.';
      const checkRows = v.checks.map((c) => {
        const val = c.ok ? `${c.ms} ms` : `${esc(c.reason || 'Failed')}, since ${dateTime(Date.parse(c.since))}`;
        return `<li class="${c.ok ? 'ok' : 'major'}">${icon(c.ok ? 'ok' : 'major')}<span>${esc(c.name)}<span class="sr">: ${c.ok ? 'working' : 'failing'}</span></span><span class="val">${val}</span></li>`;
      }).join('');
      const badText = bad.length
        ? `Days with problems: ${bad.map((d) => `${utcDate(d.t)} (${duration(d.down)})`).join(', ')}.`
        : `No problems recorded${sinceText}.`;
      return `<article class="group" aria-labelledby="g${gi}">
        <div class="g-head"><h3 id="g${gi}">${esc(g.name)}</h3><span class="pill ${v.s}">${icon(v.s)}${v.label}</span></div>
        <p class="g-desc">${esc(g.desc)}</p>
        <div class="bars" data-g="${gi}" tabindex="0" role="img" aria-label="${esc(summary)} Use the arrow keys to read each day.">${days.map((d) => `<span class="bar ${d.level}"></span>`).join('')}</div>
        <div class="axis"><span><span class="long">90 days ago</span><span class="short">${SHORT_DAYS} days ago</span></span><span class="up">${up.text}${up.since ? ` since ${date(up.since)}` : ''}</span><span>Today</span></div>
        <div class="spark">
          <div class="spark-head"><span>Response time, ${esc(sparkName.charAt(0).toLowerCase() + sparkName.slice(1))}</span><span>${last != null ? `<b>${last} ms</b> latest` : pts.length ? '<b>No answer</b> latest' : ''}${med != null ? `, median ${med} ms` : ''}</span></div>
          ${pts.length ? `<div class="spark-plot" data-g="${gi}" tabindex="0" role="img" aria-label="${esc(sparkLabel)}">${sparkSvg(pts).svg}<span class="spark-dot" hidden></span></div>` : '<p class="spark-empty">No response times yet.</p>'}
        </div>
        <details class="checks"><summary>What we check (${v.checks.length})</summary>
          <ul class="check-list">${checkRows}</ul>
          <p class="bad-days">${badText}</p>
        </details>
      </article>`;
    }).join('');
    $('#groups').innerHTML = html;
    document.querySelectorAll('.bars').forEach((el) => wireBars(el, groupDays(cur.groups[+el.dataset.g])));
    document.querySelectorAll('.spark-plot').forEach((el) => wireSpark(el, cur.groups[+el.dataset.g]));
  }

  // ---------- Tooltip, shared by bars and sparklines ----------

  const tip = $('#tip');
  let tipOwner = null;
  function showTip(owner, html, rect) {
    tipOwner = owner;
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = rect.top - th - 10;
    if (top < 8) top = rect.bottom + 10;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
  function hideTip(owner) {
    if (owner && owner !== tipOwner) return;
    tip.hidden = true;
    tipOwner = null;
  }
  const say = (text) => { $('#sr').textContent = text; };
  const narrow = () => window.matchMedia('(max-width: 640px)').matches;
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.bars, .spark-plot')) hideTip(); });
  window.addEventListener('scroll', () => hideTip(), { passive: true });
  window.addEventListener('resize', () => hideTip());

  function wireBars(el, days) {
    const bars = el.children;
    let sel = -1;
    const first = () => (narrow() ? 90 - SHORT_DAYS : 0);
    const select = (i, fromKey) => {
      if (sel >= 0 && bars[sel]) bars[sel].classList.remove('sel');
      sel = Math.max(first(), Math.min(89, i));
      bars[sel].classList.add('sel');
      showTip(el, dayTip(days[sel], sel), bars[sel].getBoundingClientRect());
      if (fromKey) say(tip.textContent);
    };
    const clear = () => { if (sel >= 0 && bars[sel]) bars[sel].classList.remove('sel'); sel = -1; hideTip(el); };
    const fromX = (x) => {
      const r = el.getBoundingClientRect();
      const n = 90 - first();
      return first() + Math.floor(((x - r.left) / r.width) * n);
    };
    el.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') select(fromX(e.clientX)); });
    el.addEventListener('pointerdown', (e) => select(fromX(e.clientX)));
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clear(); });
    el.addEventListener('blur', clear);
    el.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'Escape') { clear(); return; }
      const next = { ArrowLeft: sel - 1, ArrowRight: sel + 1, Home: first(), End: 89 }[k];
      if (next === undefined) return;
      e.preventDefault();
      select(sel < 0 ? 89 : next, true);
    });
  }

  function wireSpark(el, g) {
    const pts = sparkData(g.spark);
    const { pos } = sparkSvg(pts);
    const cross = el.querySelector('.spark-x');
    const dot = el.querySelector('.spark-dot');
    let sel = -1;
    const select = (i, fromKey) => {
      sel = Math.max(0, Math.min(pts.length - 1, i));
      const p = pts[sel];
      const at = pos(p);
      const r = el.getBoundingClientRect();
      cross.setAttribute('x1', at.x * 300);
      cross.setAttribute('x2', at.x * 300);
      cross.setAttribute('visibility', 'visible');
      dot.hidden = p.v == null;
      dot.style.left = `${at.x * 100}%`;
      dot.style.top = `${at.y * 100}%`;
      const px = r.left + at.x * r.width;
      showTip(el, `<b>${dateTime(p.t)} ${esc(tz)}</b><div class="t-row">${p.v != null ? `${p.v} ms` : 'No answer, the check failed'}</div>`, { left: px, width: 0, top: r.top, bottom: r.bottom });
      if (fromKey) say(tip.textContent);
    };
    const clear = () => { sel = -1; cross.setAttribute('visibility', 'hidden'); dot.hidden = true; hideTip(el); };
    const fromX = (x) => {
      const r = el.getBoundingClientRect();
      const f = (x - r.left) / r.width;
      let best = 0;
      pts.forEach((p, i) => { if (Math.abs(pos(p).x - f) < Math.abs(pos(pts[best]).x - f)) best = i; });
      return best;
    };
    el.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') select(fromX(e.clientX)); });
    el.addEventListener('pointerdown', (e) => select(fromX(e.clientX)));
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clear(); });
    el.addEventListener('blur', clear);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { clear(); return; }
      const next = { ArrowLeft: sel - 1, ArrowRight: sel + 1, Home: 0, End: pts.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      select(sel < 0 ? pts.length - 1 : next, true);
    });
  }

  // ---------- Overall status ----------

  const list = (names) => (names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

  function renderOverall() {
    const hero = $('#overall');
    const { cur } = state;
    let s;
    let title;
    let sub;
    if (!cur) {
      s = 'unknown';
      title = 'Status results could not be loaded';
      sub = 'Please try again in a minute. This page is separate from Viremail, so this does not mean Viremail is down.';
    } else {
      const at = Date.parse(cur.at);
      const views = cur.groups.map(groupView);
      const hit = views.filter((v) => v.failing.length);
      const open = (state.notices || []).filter((n) => n.open);
      const checked = `Results saved ${clock(at)} ${tz} (${ago(at)}).`;
      if (Date.now() - at > STALE) {
        s = 'unknown';
        title = 'These results are out of date';
        sub = `The latest results are from ${dateTime(at)} ${tz}. The checks may be paused, which does not by itself mean Viremail is down.`;
      } else if (hit.length === 1) {
        const v = hit[0];
        s = v.s === 'major' ? 'major' : 'minor';
        title = `${v.g.name} ${v.s === 'major' ? 'is down' : 'is having problems'}`;
        sub = `${checked} Everything else is working.`;
      } else if (hit.length > 1) {
        s = hit.some((v) => v.s === 'major') ? 'major' : 'minor';
        title = 'Some Viremail services are having problems';
        sub = `${list(hit.map((v) => v.g.name))} are affected. ${checked}`;
      } else if (open.some((n) => n.kind === 'incident')) {
        s = 'minor';
        title = 'We are looking into a reported problem';
        sub = `Our checks are passing. ${checked} Details below.`;
      } else if (open.length) {
        s = 'info';
        title = 'All Viremail services are working';
        sub = `Maintenance is planned or in progress, see below. ${checked}`;
      } else {
        s = 'ok';
        title = 'All Viremail services are working';
        sub = `${checked} Checks run every ${cur.every || 5} minutes, and results are saved straight away if anything changes.`;
      }
    }
    hero.dataset.state = s;
    $('#overall-icon').innerHTML = icon(s);
    $('#overall-text').textContent = title;
    $('#overall-sub').textContent = sub;
    document.title = s === 'ok' || s === 'info' ? 'Viremail status' : `${title} | Viremail status`;
  }

  // ---------- Incidents and maintenance ----------

  function plain(text, max = 800) {
    let t = String(text || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\r/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '...';
    return t;
  }

  function fromIssue(i, groupIds) {
    const labels = i.labels.map((l) => (typeof l === 'string' ? l : l.name));
    return {
      n: i.number,
      title: i.title,
      kind: labels.includes('maintenance') && !labels.includes('incident') ? 'maintenance' : 'incident',
      groups: labels.filter((l) => groupIds.includes(l)),
      auto: labels.includes('automated'),
      open: i.state === 'open',
      created: i.created_at,
      closed: i.closed_at,
      updated: i.updated_at,
      url: i.html_url,
      body: plain(i.body),
    };
  }

  async function gh(path, etag) {
    const headers = { accept: 'application/vnd.github+json' };
    if (etag) headers['if-none-match'] = etag;
    const r = await fetch(API + path, { headers, cache: 'no-store' });
    if (r.status === 304) return { same: true };
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return { data: await r.json(), etag: r.headers.get('etag') };
  }

  async function loadNotices() {
    const groupIds = state.cur ? state.cur.groups.map((g) => g.id) : [];
    const cache = store.get('vs-notices') || {};
    // A local copy of the page has no live repository to ask, so it shows the saved list.
    if (!LIVE) {
      try { state.notices = await getJson('notices.json'); } catch { state.notices = null; }
      state.noticeNote = '';
      return;
    }
    if (cache.items && Date.now() - cache.at < NOTICE_CACHE) {
      state.notices = cache.items;
      state.noticeNote = '';
      return;
    }
    try {
      const lists = {};
      const etags = {};
      for (const label of ['incident', 'maintenance']) {
        const r = await gh(`/issues?state=all&labels=${label}&per_page=30`, cache.items && cache.etags && cache.etags[label]);
        if (r.same) { lists[label] = cache.raw[label]; etags[label] = cache.etags[label]; }
        else { lists[label] = r.data.filter((i) => !i.pull_request).map((i) => fromIssue(i, groupIds)); etags[label] = r.etag; }
      }
      const seen = new Map();
      [...lists.incident, ...lists.maintenance].forEach((n) => seen.set(n.n, n));
      const items = [...seen.values()].sort((a, b) => b.created.localeCompare(a.created));
      // Updates on open items, only from people who run Viremail and from the checks themselves.
      const oldComments = cache.comments || {};
      const comments = {};
      for (const n of items.filter((x) => x.open).slice(0, 3)) {
        const prev = oldComments[n.n];
        try {
          const r = await gh(`/issues/${n.n}/comments?per_page=50`, prev && prev.etag);
          comments[n.n] = r.same ? prev : {
            etag: r.etag,
            list: r.data
              .filter((c) => TRUSTED.has(c.author_association) || (c.user && c.user.login === BOT))
              .slice(-5)
              .map((c) => ({ at: c.created_at, body: plain(c.body, 600) })),
          };
        } catch { if (prev) comments[n.n] = prev; }
        n.updates = comments[n.n] ? comments[n.n].list : [];
      }
      state.notices = items;
      state.noticeNote = '';
      store.set('vs-notices', { at: Date.now(), etags, raw: lists, items, comments });
    } catch {
      // Rate limit or no network: fall back to the copy saved with the results.
      try {
        state.notices = await getJson('notices.json');
        state.noticeNote = 'GitHub could not be reached just now, so this is the copy saved with the latest results.';
      } catch {
        state.notices = cache.items || null;
        state.noticeNote = cache.items ? `Showing the list as it was at ${clock(cache.at)}.` : '';
      }
    }
  }

  function noticeCard(n, live) {
    const created = Date.parse(n.created);
    const closed = n.closed ? Date.parse(n.closed) : null;
    const names = n.groups.map((id) => (state.cur ? (state.cur.groups.find((g) => g.id === id) || {}).name : id)).filter(Boolean);
    const affects = names.length ? ` · Affects ${esc(list(names))}` : '';
    const tag = n.kind === 'maintenance' ? 'Maintenance' : live ? 'Open' : 'Resolved';
    const when = live
      ? `${n.kind === 'maintenance' ? 'Posted' : 'Started'} ${dateTime(created)} ${esc(tz)}`
      : `${dateTime(created)}${closed ? ` to ${closed - created < DAY && new Date(closed).getDate() === new Date(created).getDate() ? clock(closed) : dateTime(closed)}` : ''} ${esc(tz)}${closed && n.kind === 'incident' ? `, about ${duration((closed - created) / MIN)}` : ''}`;
    const updates = live && n.updates && n.updates.length
      ? `<ul class="n-updates">${n.updates.slice().reverse().map((u) => `<li><time datetime="${esc(u.at)}">${dateTime(Date.parse(u.at))} ${esc(tz)}</time>${esc(u.body)}</li>`).join('')}</ul>`
      : '';
    const body = live && n.body ? `<p class="n-body">${esc(n.body)}</p>` : '';
    return `<article class="notice${live ? ' live' : ''}${n.kind === 'maintenance' ? ' maint' : ''}">
      <div class="n-top"><span class="n-title">${esc(n.title)}</span><span class="n-tag">${tag}</span></div>
      <p class="n-meta">${when}${affects}</p>${updates}${body}
      <a class="n-link" href="${esc(n.url)}">${live ? 'Follow this on GitHub' : 'Details'}</a>
    </article>`;
  }

  function renderNotices() {
    const items = state.notices;
    const note = state.noticeNote ? `<p class="muted">${esc(state.noticeNote)}</p>` : '';
    if (!items) {
      $('#now').hidden = true;
      $('#past-list').innerHTML = `<p class="muted">Incidents could not be loaded right now. You can <a href="${ISSUES}">see them on GitHub</a>.</p>`;
      return;
    }
    const open = items.filter((n) => n.open);
    $('#now').hidden = !open.length;
    $('#now-list').innerHTML = open.map((n) => noticeCard(n, true)).join('');
    const cutoff = Date.now() - 90 * DAY;
    const past = items.filter((n) => !n.open && Date.parse(n.closed || n.created) > cutoff);
    if (!past.length) {
      $('#past-list').innerHTML = `${note}<p class="muted">No incidents or maintenance in the last 90 days.</p>`;
      return;
    }
    let month = '';
    const html = past.slice(0, 20).map((n) => {
      const d = new Date(Date.parse(n.created));
      const m = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      const head = m !== month ? `<h3 class="month">${m}</h3>` : '';
      month = m;
      return head + noticeCard(n, false);
    }).join('');
    $('#past-list').innerHTML = `${note}${html}<p><a href="${ISSUES}">All incidents and maintenance on GitHub</a></p>`;
  }

  // ---------- Loading ----------

  async function load() {
    try {
      const [cur, up, resp] = await Promise.all([getJson('current.json'), getJson('uptime.json'), getJson('response.json')]);
      Object.assign(state, { cur, up, resp });
    } catch {
      if (!state.cur) {
        renderOverall();
        $('#groups').innerHTML = '<p class="muted">Service results will show here once they load.</p>';
        await loadNotices();
        renderNotices();
        return;
      }
    }
    state.loadedAt = Date.now();
    renderGroups();
    renderOverall();
    await loadNotices();
    renderNotices();
    renderGroups();
    renderOverall();
  }

  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - state.loadedAt > REFRESH) load();
  });
})();
