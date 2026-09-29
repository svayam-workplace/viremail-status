// Runs every check once, updates the files in data/, opens or closes incidents,
// and tells the workflow whether this run is worth a commit.
//
//   node scripts/run.mjs            normal run (incidents only when GITHUB_TOKEN is set)
//   node scripts/run.mjs --dry      run the checks and print them, write nothing

import { appendFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { CHECKS, GROUPS, runCheck, control } from './checks.mjs';
import { github, openIncident, closeIncident, fetchNotices, atomFeed } from './github.mjs';

const SITE = 'https://status.viremail.com';
const ROOT = new URL('../', import.meta.url);
const DATA = new URL('data/', ROOT);
const MIN = 60000;
const DAY = 24 * 60 * MIN;
const DAYS = 90; // days of uptime kept
const SAMPLES = 72; // response time points kept
const SAMPLE_AGE = 3 * DAY;
const SAVE_EVERY = 55 * MIN; // save at least hourly while nothing changes
const RUN_GAP = 5 * MIN; // how often the schedule asks for a run
const MAX_SPAN = 2 * 60 * MIN; // longer gaps than this are counted as no data

const dry = process.argv.includes('--dry');

async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(new URL(name, DATA), 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeIfChanged(url, text) {
  let old = null;
  try { old = await readFile(url, 'utf8'); } catch {}
  if (old !== text) await writeFile(url, text);
  return old !== text;
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dayKey = (ms) => iso(ms).slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;

// Uptime is counted in minutes, not in samples: runs that were not saved had the same result
// as the last saved one (a change always saves), so the time since the last save belongs to
// that earlier state, and only the last few minutes belong to what this run saw.
function creditTime(uptime, prev, results, now) {
  const byDay = {};
  for (const c of CHECKS) {
    byDay[c.id] = new Map();
    const arr = uptime.checks?.[c.id] || [];
    const from = uptime.from ? Date.parse(uptime.from + 'T00:00:00Z') : 0;
    arr.forEach((v, i) => { if (v) byDay[c.id].set(dayKey(from + i * DAY), v.slice()); });
  }

  const add = (id, a, b, ok) => {
    while (a < b) {
      const end = Math.min(b, Math.floor(a / DAY) * DAY + DAY);
      const key = dayKey(a);
      const cell = byDay[id].get(key) || [0, 0];
      const mins = (end - a) / MIN;
      if (!ok) cell[0] = round1(cell[0] + mins);
      cell[1] = round1(cell[1] + mins);
      byDay[id].set(key, cell);
      a = end;
    }
  };

  const last = prev?.at ? Date.parse(prev.at) : null;
  for (const r of results) {
    const before = prev?.checks?.[r.id];
    const cut = now - RUN_GAP;
    if (last && before && now > last && now - last <= MAX_SPAN) {
      add(r.id, last, Math.max(last, cut), before.ok);
      add(r.id, Math.max(last, cut), now, r.ok);
    } else {
      add(r.id, cut, now, r.ok); // first run, new check, or after a long gap
    }
  }

  const today = Math.floor(now / DAY) * DAY;
  const from = today - (DAYS - 1) * DAY;
  const checks = {};
  for (const c of CHECKS) {
    checks[c.id] = Array.from({ length: DAYS }, (_, i) => byDay[c.id].get(dayKey(from + i * DAY)) || null);
  }
  return { from: dayKey(from), checks };
}

function addSample(resp, results, now) {
  const t = [...(resp.t || []), Math.round(now / 1000)];
  const ms = {};
  for (const c of CHECKS) {
    const old = resp.ms?.[c.id] || [];
    const padded = Array(Math.max(0, t.length - 1 - old.length)).fill(null).concat(old);
    ms[c.id] = [...padded, results.find((r) => r.id === c.id)?.ms ?? null];
  }
  let keep = t.length;
  let start = 0;
  while (keep - start > SAMPLES || (t[start] && now / 1000 - t[start] > SAMPLE_AGE / 1000)) start++;
  for (const id of Object.keys(ms)) ms[id] = ms[id].slice(start);
  return { t: t.slice(start), ms };
}

const signature = (cur) =>
  JSON.stringify({
    c: Object.fromEntries(Object.entries(cur?.checks || {}).map(([id, c]) => [id, [c.ok, Math.min(c.fails || 0, 2)]])),
    i: cur?.incidents || {},
  });

async function main() {
  const now = Date.now();

  if (!(await control())) {
    console.log('The runner could not reach GitHub either, so this run says nothing about Viremail. Nothing saved.');
    output('commit', 'false');
    return;
  }

  const results = await Promise.all(CHECKS.map(runCheck));

  console.log('Check                     Result  Time     Reason');
  for (const r of results) {
    const name = CHECKS.find((c) => c.id === r.id).name;
    console.log(`${name.padEnd(26)}${(r.ok ? 'ok' : 'FAIL').padEnd(8)}${(r.ms != null ? r.ms + ' ms' : '').padEnd(9)}${r.reason}`);
  }
  if (dry) return;

  const prev = await readJson('current.json', null);
  const uptime = await readJson('uptime.json', { from: null, checks: {} });
  const resp = await readJson('response.json', { t: [], ms: {} });
  const oldNotices = await readJson('notices.json', null);

  const checks = {};
  for (const r of results) {
    const p = prev?.checks?.[r.id];
    const changed = !p || p.ok !== r.ok;
    checks[r.id] = {
      ok: r.ok,
      ms: r.ms,
      ...(r.reason ? { reason: r.reason } : {}),
      since: changed ? iso(now) : p.since,
      fails: r.ok ? 0 : Math.min((p?.fails || 0) + 1, 999),
    };
  }

  // Incidents: open after two failed runs in a row, close when every check in the group passes.
  const incidents = { ...(prev?.incidents || {}) };
  let notices = oldNotices;
  const gh = github();
  if (gh) {
    for (const g of GROUPS) {
      const failing = g.checks.filter((id) => checks[id].fails >= 2);
      const allOk = g.checks.every((id) => checks[id].ok);
      try {
        if (failing.length && !incidents[g.id]) {
          const since = Math.min(...failing.map((id) => Date.parse(checks[id].since)));
          const detail = failing.map((id) => ({ name: CHECKS.find((c) => c.id === id).name, reason: checks[id].reason }));
          const issue = await openIncident(gh, g, detail, since);
          incidents[g.id] = { issue, since: iso(since) };
          console.log(`Opened incident #${issue} for ${g.name}.`);
        } else if (allOk && incidents[g.id]) {
          const { issue, since } = incidents[g.id];
          await closeIncident(gh, g, issue, Date.parse(since), now);
          delete incidents[g.id];
          console.log(`Closed incident #${issue} for ${g.name}.`);
        }
      } catch (err) {
        if ((err.status === 404 || err.status === 410) && incidents[g.id] && allOk) {
          // The issue was deleted or moved by hand. Forget it rather than retrying for ever.
          delete incidents[g.id];
          console.log(`The incident issue for ${g.name} no longer exists, so it is no longer tracked.`);
          continue;
        }
        console.log(`Could not update the incident for ${g.name}: ${err.message}. Trying again next run.`);
      }
    }
    try {
      notices = await fetchNotices(gh, GROUPS.map((g) => g.id));
      // An automatic incident can be left open if a run opened it but its save never landed.
      // Once that service is fully working again, close it like any other.
      let closedStray = false;
      for (const n of notices.filter((x) => x.open && x.auto && x.kind === 'incident')) {
        const g = GROUPS.find((x) => n.groups.includes(x.id));
        if (!g || incidents[g.id] || !g.checks.every((id) => checks[id].ok)) continue;
        try {
          await closeIncident(gh, g, n.n, Date.parse(n.created), now);
          closedStray = true;
          console.log(`Closed incident #${n.n} for ${g.name}, which was left open by an earlier run.`);
        } catch (err) {
          console.log(`Could not close incident #${n.n}: ${err.message}. Trying again next run.`);
        }
      }
      if (closedStray) notices = await fetchNotices(gh, GROUPS.map((g) => g.id));
    } catch (err) {
      console.log(`Could not read incident notes: ${err.message}. Keeping the saved list.`);
    }
  } else {
    console.log('No GitHub token here, so incidents are not opened or closed and notes are not refreshed.');
  }

  const current = {
    v: 1,
    at: iso(now),
    every: RUN_GAP / MIN,
    groups: GROUPS.map(({ id, name, desc, checks: ids, spark }) => ({ id, name, desc, checks: ids, spark })),
    names: Object.fromEntries(CHECKS.map((c) => [c.id, c.name])),
    checks,
    incidents,
  };

  const noticesChanged = JSON.stringify(notices) !== JSON.stringify(oldNotices);
  const due = !prev?.at || now - Date.parse(prev.at) >= SAVE_EVERY;
  const commit = due || noticesChanged || signature(prev) !== signature(current);

  await mkdir(DATA, { recursive: true });
  await writeFile(new URL('current.json', DATA), JSON.stringify(current) + '\n');
  await writeFile(new URL('uptime.json', DATA), JSON.stringify(creditTime(uptime, prev, results, now)) + '\n');
  await writeFile(new URL('response.json', DATA), JSON.stringify(addSample(resp, results, now)) + '\n');
  if (notices) {
    await writeIfChanged(new URL('notices.json', DATA), JSON.stringify(notices) + '\n');
    await writeIfChanged(new URL('feed.xml', ROOT), atomFeed(notices, SITE));
  }

  console.log(commit ? 'Saving this run.' : 'Nothing changed and the last save is recent, so this run is not saved.');
  output('commit', String(commit));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
