// GitHub issues as the incident log. Used only inside the workflow, with its own short-lived token.

import { UA } from './checks.mjs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';

const LABELS = {
  incident: { color: 'd73a4a', description: 'Something is not working. Shown on the status page.' },
  maintenance: { color: '0969da', description: 'Planned work. Shown on the status page.' },
  automated: { color: '6e7781', description: 'Opened by the status checks' },
};

export function github() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return null;

  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': UA,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const err = new Error(`GitHub answered ${res.status} to ${method} ${path.split('?')[0]}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async function ensureLabels(groups) {
    const wanted = { ...LABELS };
    for (const g of groups) wanted[g.id] = { color: 'ededed', description: `Affects ${g.name.toLowerCase()}` };
    for (const [name, v] of Object.entries(wanted)) {
      try {
        await call('/labels', { method: 'POST', body: { name, ...v } });
      } catch (err) {
        if (err.status !== 422) throw err; // 422 means it already exists
      }
    }
  }

  return { repo, call, ensureLabels };
}

const marker = (groupId) => `<!-- viremail-status:${groupId} -->`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function when(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function minutesText(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 6) / 10;
  return `${h} hours`;
}

export async function openIncident(gh, group, failing, since) {
  const open = await gh.call('/issues?state=open&labels=incident,automated&per_page=50');
  const existing = open.find((i) => (i.body || '').includes(marker(group.id)));
  if (existing) return existing.number;

  await gh.ensureLabels([group]);
  const lines = failing.map((c) => `- ${c.name}: ${c.reason || 'failed'}`).join('\n');
  const issue = await gh.call('/issues', {
    method: 'POST',
    body: {
      title: `Problem with ${group.name.toLowerCase()}`,
      labels: ['incident', 'automated', group.id],
      body:
        `Our automatic checks found a problem with ${group.name.toLowerCase()}, starting ${when(since)}.\n\n` +
        `Failing checks:\n${lines}\n\n` +
        'This issue gets a comment and closes on its own when the checks pass again. ' +
        'We may add notes here while we look into it.\n\n' +
        marker(group.id),
    },
  });
  return issue.number;
}

export async function closeIncident(gh, group, issue, since, now) {
  const took = since ? `, about ${minutesText(now - since)} after the problem started` : '';
  await gh.call(`/issues/${issue}/comments`, {
    method: 'POST',
    body: { body: `${group.name} is working again. The checks passed at ${when(now)}${took}.` },
  });
  await gh.call(`/issues/${issue}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
}

// Plain text for the page and the feed: no markdown syntax, no hidden markers.
export function plain(text, max = 800) {
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

// Incidents and maintenance notes, saved next to the results so the page and the feed
// still work when GitHub's public API limit is reached.
export async function fetchNotices(gh, groupIds) {
  const lists = await Promise.all(
    ['incident', 'maintenance'].map((l) => gh.call(`/issues?state=all&labels=${l}&per_page=30&sort=created&direction=desc`)),
  );
  const seen = new Map();
  for (const issue of lists.flat()) {
    if (issue.pull_request || seen.has(issue.number)) continue;
    const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
    seen.set(issue.number, {
      n: issue.number,
      title: issue.title,
      kind: labels.includes('maintenance') && !labels.includes('incident') ? 'maintenance' : 'incident',
      groups: labels.filter((l) => groupIds.includes(l)),
      auto: labels.includes('automated'),
      open: issue.state === 'open',
      created: issue.created_at,
      closed: issue.closed_at,
      updated: issue.updated_at,
      url: issue.html_url,
      body: plain(issue.body),
    });
  }
  return [...seen.values()].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 40);
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

export function atomFeed(notices, site) {
  const updated = notices.reduce((m, n) => (n.updated > m ? n.updated : m), '2026-09-29T00:00:00Z');
  const entries = notices.slice(0, 30).map((n) => {
    const state = n.open ? (n.kind === 'maintenance' ? 'Planned or in progress' : 'Open') : 'Resolved';
    const text = `${state}. ${n.body}`.trim();
    return [
      '  <entry>',
      `    <id>${xml(n.url)}</id>`,
      `    <title>${xml(`${n.kind === 'maintenance' ? 'Maintenance' : 'Incident'}: ${n.title}`)}</title>`,
      `    <link rel="alternate" href="${xml(n.url)}"/>`,
      `    <published>${xml(n.created)}</published>`,
      `    <updated>${xml(n.updated)}</updated>`,
      `    <content type="text">${xml(text)}</content>`,
      '  </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>Viremail status</title>',
    '  <subtitle>Incidents and planned maintenance for Viremail</subtitle>',
    `  <id>${site}/</id>`,
    `  <link rel="alternate" href="${site}/"/>`,
    `  <link rel="self" href="${site}/feed.xml"/>`,
    `  <updated>${xml(updated)}</updated>`,
    '  <author><name>Viremail</name></author>',
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
