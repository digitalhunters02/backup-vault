// HTTP API (plain node:http). Every route except GET /health needs the X-Backup-Key header.
import http from 'node:http';
import crypto from 'node:crypto';
import { HttpError } from './configStore.js';
import { redact } from './redact.js';

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new HttpError(413, 'request body too large');
    chunks.push(c);
  }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'body is not valid JSON'); }
}

export function createApp({ env, vault, log }) {
  const send = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
    res.end(data);
  };

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler });

  route('GET', '/targets', async () => ({ targets: await vault.listTargets() }));
  route('POST', '/targets', async ({ body }) => [201, await vault.createTarget(body)]);
  route('GET', '/targets/:name', async ({ params }) => vault.getTarget(params.name));
  route('PUT', '/targets/:name', async ({ params, body }) => vault.updateTarget(params.name, body));
  route('DELETE', '/targets/:name', async ({ params, query }) => vault.deleteTarget(params.name, { deleteBackups: query.get('deleteBackups') === 'true' }));
  route('POST', '/targets/:name/test', async ({ params }) => vault.testTarget(params.name));
  route('POST', '/targets/:name/run', async ({ params, query }) => {
    await vault.ensureReady();
    const job = vault.enqueue(params.name, 'manual');
    if (query.get('wait') === 'true' || query.get('wait') === '1') return job.promise;
    return [202, { accepted: true, target: params.name, message: 'backup queued; follow it in GET /targets/:name/runs or GET /status' }];
  });
  route('GET', '/targets/:name/runs', async ({ params, query }) => {
    const limit = Math.min(200, Math.max(1, parseInt(query.get('limit') || '20', 10) || 20));
    return { runs: await vault.listRuns(params.name, limit) };
  });
  route('GET', '/targets/:name/backups', async ({ params }) => ({ backups: await vault.backups(params.name) }));
  route('GET', '/backups/download-url', async ({ query }) => vault.downloadUrl(query.get('key')));
  route('DELETE', '/backups', async ({ query }) => vault.deleteBackup(query.get('key')));
  route('POST', '/bucket/test', async () => vault.bucketTest());
  route('GET', '/status', async ({ query }) => vault.status({ refresh: query.get('refresh') === 'true' }));

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let status = 500;
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && pathname === '/health') { status = 200; return send(res, 200, { ok: true }); }
      if (!safeEqual(req.headers['x-backup-key'], env.apiKey)) {
        status = 401; return send(res, 401, { error: 'unauthorized: missing or wrong X-Backup-Key header' });
      }
      let matchedPath = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        matchedPath = true;
        if (r.method !== req.method) continue;
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : undefined;
        const out = await r.handler({ params: m.groups || {}, query: url.searchParams, body });
        if (Array.isArray(out) && typeof out[0] === 'number') { status = out[0]; return send(res, out[0], out[1]); }
        status = 200;
        return send(res, 200, out);
      }
      status = matchedPath ? 405 : 404;
      return send(res, status, { error: matchedPath ? 'method not allowed' : 'not found' });
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; return send(res, e.status, { error: redact(e.message), ...(e.extra || {}) }); }
      status = 500;
      log.error(`unhandled error on ${req.method} ${pathname}: ${e.stack || e.message}`);
      return send(res, 500, { error: 'internal error: ' + redact(e.message) });
    } finally {
      if (pathname !== '/health') log.info(`${req.method} ${pathname} -> ${status} (${Date.now() - started} ms)`);
    }
  });
  return server;
}
