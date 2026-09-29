// What the status page checks. Node built-ins only, read-only requests, no logins.
// Reasons are short fixed phrases: they never repeat what a server said about itself.

import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

const SITE = 'https://viremail.com';
const MAIL_HOST = 'mail.viremail.com';
const MANIFEST = 'https://github.com/svayam-workplace/viremail-desktop/releases/latest/download/release.json';
const TIMEOUT = 15000;
const RETRY_AFTER = 3000;
export const UA = 'ViremailStatus/1.0 (+https://status.viremail.com)';

class CheckError extends Error {}
const fail = (reason) => { throw new CheckError(reason); };

// Public resolvers, so a problem with the runner's own resolver does not look like ours.
const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(['8.8.8.8', '1.1.1.1']);

async function page(path, { mustInclude, url } = {}) {
  const res = await fetch(url || SITE + path, {
    headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'cache-control': 'no-cache' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.text();
  if (res.status !== 200) fail(`HTTP ${res.status}`);
  if (mustInclude && !mustInclude.test(body)) fail('Page was incomplete');
  return body;
}

// Connects, waits for the first line the server sends, checks its shape, then says goodbye.
// The line itself is never stored or printed.
function greeting({ port, secure, expect, bye }) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const sock = secure
      ? tls.connect({ host: MAIL_HOST, port, servername: MAIL_HOST })
      : net.connect({ host: MAIL_HOST, port });
    const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), TIMEOUT);
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        sock.destroy();
        reject(err);
        return;
      }
      try { sock.end(bye); } catch { sock.destroy(); }
      setTimeout(() => sock.destroy(), 1000);
      resolve();
    }
    sock.setEncoding('latin1');
    sock.on('data', (chunk) => {
      buf += chunk;
      const end = buf.indexOf('\n');
      if (end === -1) {
        if (buf.length > 2048) finish(new CheckError('Unexpected greeting'));
        return;
      }
      finish(expect.test(buf.slice(0, end)) ? null : new CheckError('Unexpected greeting'));
    });
    sock.on('error', finish);
    sock.on('close', () => finish(new CheckError('Closed before greeting')));
  });
}

export const CHECKS = [
  {
    id: 'home',
    name: 'Home page and web app',
    run: () => page('/', { mustInclude: /id="root"/ }),
  },
  {
    id: 'api',
    name: 'App service health',
    run: async () => {
      const body = await page('/api/health');
      let data;
      try { data = JSON.parse(body); } catch { fail('Answer was not valid JSON'); }
      if (!data || data.ok !== true) fail('Service did not report ok');
    },
  },
  {
    id: 'features',
    name: 'Features page',
    run: () => page('/features', { mustInclude: /<title>[^<]*Viremail/ }),
  },
  {
    id: 'dns-web',
    name: 'Domain name viremail.com',
    run: async () => {
      const a = await resolver.resolve4('viremail.com');
      if (!a.length) fail('No address records');
    },
  },
  {
    id: 'login',
    name: 'Sign-in page',
    run: () => page('/login', { mustInclude: /id="root"/ }),
  },
  {
    id: 'send-465',
    name: 'Port 465 (secure)',
    run: () => greeting({ port: 465, secure: true, expect: /^220[ -]/, bye: 'QUIT\r\n' }),
  },
  {
    id: 'send-587',
    name: 'Port 587',
    run: () => greeting({ port: 587, secure: false, expect: /^220[ -]/, bye: 'QUIT\r\n' }),
  },
  {
    id: 'access-993',
    name: 'Port 993 (secure)',
    run: () => greeting({ port: 993, secure: true, expect: /^\* OK/i, bye: 'a1 LOGOUT\r\n' }),
  },
  {
    id: 'dns-mail',
    name: 'Mail domain records',
    run: async () => {
      const [a, mx] = await Promise.all([resolver.resolve4(MAIL_HOST), resolver.resolveMx('viremail.com')]);
      if (!a.length) fail('No address records');
      if (!mx.some((r) => r.exchange.toLowerCase().replace(/\.$/, '') === MAIL_HOST)) fail('Mail records point elsewhere');
    },
  },
  {
    id: 'desktop-page',
    name: 'Desktop download page',
    run: () => page('/desktop', { mustInclude: /<title>[^<]*Viremail/ }),
  },
  {
    id: 'desktop-manifest',
    name: 'Desktop update list',
    run: async () => {
      const body = await page('', { url: MANIFEST });
      let data;
      try { data = JSON.parse(body); } catch { fail('Update list was not valid JSON'); }
      if (!data || typeof data.version !== 'string' || !data.version) fail('Update list had no version');
    },
  },
];

// A group is what a person cares about. A check can sit in more than one group.
// Group ids double as GitHub issue labels, so a manual note can name the service it affects.
export const GROUPS = [
  {
    id: 'website',
    name: 'Website and app',
    desc: 'viremail.com, the web app and the service behind it.',
    checks: ['home', 'api', 'features', 'dns-web'],
    spark: 'home',
  },
  {
    id: 'sign-in',
    name: 'Sign-in',
    desc: 'The sign-in page and the app service it talks to.',
    checks: ['login', 'api'],
    spark: 'login',
  },
  {
    id: 'mail-sending',
    name: 'Mail sending',
    desc: 'Sending mail, for Viremail and for mail apps on ports 465 and 587.',
    checks: ['send-465', 'send-587', 'dns-mail'],
    spark: 'send-465',
  },
  {
    id: 'mail-access',
    name: 'Mail access',
    desc: 'Reaching your mailbox, for Viremail and for mail apps on port 993.',
    checks: ['access-993', 'dns-mail'],
    spark: 'access-993',
  },
  {
    id: 'desktop',
    name: 'Desktop downloads',
    desc: 'The desktop app page and the update list the app reads.',
    checks: ['desktop-page', 'desktop-manifest'],
    spark: 'desktop-manifest',
  },
];

export function reasonFrom(err) {
  if (err instanceof CheckError) return err.message;
  const code = String(err?.code || err?.cause?.code || '');
  const name = String(err?.name || err?.cause?.name || '');
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT|TIMEDOUT/i.test(code)) return 'Timed out';
  if (/ENOTFOUND|ENODATA|EAI_AGAIN|ESERVFAIL|NXDOMAIN|ENONAME|EREFUSED/.test(code)) return 'Name did not resolve';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|ECONNABORTED/.test(code)) return 'Connection dropped';
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/.test(code)) return 'Could not be reached';
  if (code === 'CERT_HAS_EXPIRED') return 'Certificate expired';
  if (/CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) return 'Certificate problem';
  if (/ERR_SSL|EPROTO|ERR_TLS/.test(code)) return 'Secure connection failed';
  if (/UND_ERR_BODY|UND_ERR_RESPONSE|HPE_/.test(code)) return 'Answer was cut short';
  return 'Check failed';
}

async function once(check) {
  const t0 = performance.now();
  try {
    await check.run();
    return { ok: true, ms: Math.round(performance.now() - t0), reason: '' };
  } catch (err) {
    return { ok: false, ms: null, reason: reasonFrom(err) };
  }
}

// One quiet retry inside a run smooths over a single dropped packet.
// Incidents still need two failed runs in a row.
export async function runCheck(check) {
  let r = await once(check);
  if (!r.ok) {
    await new Promise((res) => setTimeout(res, RETRY_AFTER));
    r = await once(check);
  }
  return { id: check.id, ...r };
}

// If the runner cannot reach GitHub either, its network is at fault and the run proves nothing about Viremail.
export async function control() {
  try {
    const res = await fetch('https://github.com/', { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT) });
    return res.status < 500;
  } catch {
    return false;
  }
}
