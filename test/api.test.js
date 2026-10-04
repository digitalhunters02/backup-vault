import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Vault } from '../src/vault.js';
import { createApp, safeEqual } from '../src/api.js';
import { createLogger } from '../src/logger.js';
import { clearSecrets, registerSecret } from '../src/redact.js';
import { loadEnv, ConfigError } from '../src/config.js';
import { MemoryStorage, baseEnv, API_PORT } from './helpers.js';
import { msToTs } from '../src/keys.js';

const KEY = 'test-api-key-0123456789';
const PASS = 'Sup3rSecretPw';
const URL_RAW = `postgres://crm:${PASS}@rex-db:5432/rex`;
const H = { 'X-Backup-Key': KEY, 'Content-Type': 'application/json', Connection: 'close' };

async function boot({ env = baseEnv(), storage = new MemoryStorage(), now, runner } = {}) {
  clearSecrets(); registerSecret(KEY); registerSecret(PASS);
  const lines = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  const vault = new Vault({ env, storage, log, now, runner });
  const server = createApp({ env, vault, log });
  await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r));
  const call = async (method, path, body, headers = H) => {
    headers = { Connection: 'close', ...headers };
    const res = await fetch(`http://127.0.0.1:${API_PORT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text };
  };
  return { vault, storage, lines, call, close: () => new Promise((r) => { vault.stopScheduler(); server.close(r); server.closeAllConnections?.(); }) };
}

test('config: refuses to start without BACKUP_API_KEY (process exits non-zero)', () => {
  const base = { PATH: process.env.PATH, S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's', BACKUP_CONFIG_KEY: 'x'.repeat(20), PORT: '4590' };
  const r = spawnSync('node', ['src/server.js'], { cwd: new URL('..', import.meta.url).pathname, env: base, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BACKUP_API_KEY is required/);
  assert.throws(() => loadEnv({ ...base, BACKUP_API_KEY: 'short' }), ConfigError);
  const env = loadEnv({ ...base, BACKUP_API_KEY: 'k'.repeat(20), S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com' });
  assert.equal(env.s3.region, 'us-west-004');
  assert.equal(env.s3.prefix, 'vault');
  assert.equal(env.tz, 'America/Denver');
  assert.equal(env.port, 4590);
  assert.equal(env.s3.forcePathStyle, true);
});

test('safeEqual is a correct comparison', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(safeEqual('', ''), true);
});

test('API auth: /health is open, everything else needs X-Backup-Key', async () => {
  const s = await boot();
  try {
    assert.deepEqual((await s.call('GET', '/health', undefined, {})).json, { ok: true });
    const routes = [['GET', '/status'], ['GET', '/targets'], ['POST', '/targets'], ['GET', '/targets/x'], ['PUT', '/targets/x'], ['DELETE', '/targets/x'],
      ['POST', '/targets/x/test'], ['POST', '/targets/x/run'], ['GET', '/targets/x/runs'], ['GET', '/targets/x/backups'],
      ['GET', '/backups/download-url?key=a'], ['POST', '/bucket/test'], ['DELETE', '/backups?key=a'], ['GET', '/nonexistent']];
    for (const [m, p] of routes) {
      const none = await s.call(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, {});
      assert.equal(none.status, 401, `${m} ${p} without key`);
      const wrong = await s.call(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, { 'X-Backup-Key': 'wrong-key-wrong-key-1' });
      assert.equal(wrong.status, 401, `${m} ${p} with wrong key`);
    }
    assert.equal((await s.call('GET', '/status')).status, 200);
    assert.equal((await s.call('GET', '/nope')).status, 404);
    assert.equal((await s.call('PATCH', '/targets')).status, 405);
  } finally { await s.close(); }
});

test('targets CRUD: validation, redacted URLs, encrypted at rest, never the password in any response or log', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('GET', '/targets')).json.targets.length, 0, 'empty list on first run');
    const bad = [
      { name: 'Bad Name', url: URL_RAW }, { name: '_vault', url: URL_RAW }, { name: 'a', url: 'mysql://u:p@h/db' },
      { name: 'a', url: URL_RAW, schedule: { type: 'daily', time: '99:00' } }, { name: 'a', url: URL_RAW, retention: { daily: 0 } },
      { name: 'a' }, { name: 'a', url: 'postgres://u:p@h:5432' },
    ];
    for (const b of bad) assert.equal((await s.call('POST', '/targets', b)).status, 400, JSON.stringify(b).replace(PASS, '***'));

    const created = await s.call('POST', '/targets', { name: 'rex', url: URL_RAW });
    assert.equal(created.status, 201);
    assert.equal(created.json.url, 'postgres://crm:***@rex-db:5432/rex');
    assert.deepEqual(created.json.retention, { daily: 7, weekly: 4, monthly: 6 });
    assert.deepEqual(created.json.schedule, { type: 'daily', time: '03:00' });
    assert.equal(created.json.enabled, true);
    assert.equal((await s.call('POST', '/targets', { name: 'rex', url: URL_RAW })).status, 409);

    const upd = await s.call('PUT', '/targets/rex', { schedule: { type: 'interval', everyHours: 6 }, retention: { daily: 3, weekly: 2, monthly: 1 }, enabled: false });
    assert.equal(upd.status, 200);
    assert.deepEqual(upd.json.schedule, { type: 'interval', everyHours: 6 });
    assert.equal(upd.json.enabled, false);
    assert.equal(upd.json.url, 'postgres://crm:***@rex-db:5432/rex', 'url untouched by partial update');
    assert.equal((await s.call('PUT', '/targets/rex', { name: 'other' })).status, 400);
    assert.equal((await s.call('PUT', '/targets/ghost', { enabled: true })).status, 404);

    const newPass = 'N3wPassw0rd';
    registerSecret(newPass);
    const upd2 = await s.call('PUT', '/targets/rex', { url: `postgres://crm:${newPass}@rex-db:5432/rex` });
    assert.equal(upd2.json.url, 'postgres://crm:***@rex-db:5432/rex');

    const list = await s.call('GET', '/targets');
    const one = await s.call('GET', '/targets/rex');
    for (const r of [created, upd, upd2, list, one]) {
      assert.ok(!r.text.includes(PASS) && !r.text.includes(newPass), 'password leaked in a response');
    }
    // stored encrypted
    const stored = await s.storage.getText('vault/_vault/config.json');
    assert.ok(!stored.includes(PASS) && !stored.includes(newPass) && !stored.includes('rex-db'));
    assert.equal(JSON.parse(stored).targets.length, 1);
    assert.ok(!s.lines.join('\n').includes(PASS));

    assert.equal((await s.call('DELETE', '/targets/rex')).status, 200);
    assert.equal((await s.call('GET', '/targets/rex')).status, 404);
  } finally { await s.close(); }
});

test('first run with an empty bucket works; BACKUP_TARGETS_JSON seeds only when there is no config', async () => {
  const storage = new MemoryStorage();
  const env = baseEnv({ seed: [{ name: 'seeded', url: URL_RAW, schedule: { type: 'interval', everyHours: 12 } }] });
  const s = await boot({ env, storage });
  try {
    const list = (await s.call('GET', '/targets')).json.targets;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'seeded');
    assert.equal(list[0].schedule.everyHours, 12);
    assert.ok(!(await storage.getText('vault/_vault/config.json')).includes(PASS));
    await s.call('DELETE', '/targets/seeded');
  } finally { await s.close(); }
  // restart with the same seed env: bucket already has a config (now empty) => NOT re-seeded
  const s2 = await boot({ env, storage });
  try { assert.equal((await s2.call('GET', '/targets')).json.targets.length, 0); } finally { await s2.close(); }
});

test('stateless: a brand new process pointed at the same bucket sees targets and history', async () => {
  const storage = new MemoryStorage();
  const s = await boot({ storage });
  await s.call('POST', '/targets', { name: 'rex', url: URL_RAW });
  await s.close();
  const s2 = await boot({ storage });
  try { assert.equal((await s2.call('GET', '/targets')).json.targets[0].name, 'rex'); } finally { await s2.close(); }
});

function seedHistory(storage, name, { okAgeH, failedAgeH, now }) {
  const out = [];
  if (okAgeH != null) {
    const t = now - okAgeH * 3_600_000;
    const ts = msToTs(t);
    const key = `vault/${name}/${new Date(t).getUTCFullYear()}/${String(new Date(t).getUTCMonth() + 1).padStart(2, '0')}/${name}-${ts}.dump`;
    storage.objects.set(key, { body: Buffer.alloc(100), lastModified: t });
    out.push(storage.putJson(`vault/_vault/runs/${name}/${ts}.json`, { target: name, status: 'success', startedAt: new Date(t).toISOString(), finishedAt: new Date(t + 1000).toISOString(), durationMs: 1000, sizeBytes: 100, key, verified: true }));
  }
  if (failedAgeH != null) {
    const t = now - failedAgeH * 3_600_000;
    out.push(storage.putJson(`vault/_vault/runs/${name}/${msToTs(t)}.json`, { target: name, status: 'failed', startedAt: new Date(t).toISOString(), finishedAt: new Date(t + 1000).toISOString(), error: 'dump: boom' }));
  }
  return Promise.all(out);
}

test('/status: healthy -> stale -> failing, per-target data and totals', async () => {
  const NOW = Date.UTC(2026, 5, 10, 12);
  const storage = new MemoryStorage();
  const mkTarget = (name) => ({ name, url: URL_RAW.replace('rex', name) });
  const s = await boot({ storage, now: () => NOW });
  try {
    for (const n of ['good', 'old', 'bad']) await s.call('POST', '/targets', mkTarget(n));
    // created "now"; history:
    await seedHistory(storage, 'good', { okAgeH: 5, now: NOW });
    await seedHistory(storage, 'old', { okAgeH: 60, now: NOW });
    await seedHistory(storage, 'bad', { okAgeH: 30, failedAgeH: 2, now: NOW });
    s.vault.usageCache = null;
    let st = (await s.call('GET', '/status?refresh=true')).json;
    const by = Object.fromEntries(st.targets.map((t) => [t.name, t]));
    assert.equal(by.good.status, 'healthy');
    assert.equal(by.old.status, 'stale');
    assert.equal(by.bad.status, 'failing');
    assert.equal(st.status, 'failing');
    assert.equal(by.bad.lastRun.status, 'failed');
    assert.equal(by.bad.lastRun.error, 'dump: boom');
    assert.ok(by.bad.lastSuccess.at);
    assert.ok(by.good.nextRunAt);
    assert.equal(by.good.backupCount, 1);
    assert.equal(by.good.storedBytes, 100);
    assert.equal(st.totalStoredBytes, 300 + (await storage.list('vault/_vault/')).reduce((a, o) => a + o.size, 0));
    await s.call('DELETE', '/targets/bad');
    st = (await s.call('GET', '/status?refresh=true')).json;
    assert.equal(st.status, 'stale');
    await s.call('DELETE', '/targets/old');
    st = (await s.call('GET', '/status?refresh=true')).json;
    assert.equal(st.status, 'healthy');
    assert.equal(st.timezone, 'America/Denver');
  } finally { await s.close(); }
});

test('backups listing, presigned download URL, manual delete (never the newest, never foreign keys)', async () => {
  const NOW = Date.UTC(2026, 5, 10, 12);
  const storage = new MemoryStorage();
  const s = await boot({ storage, now: () => NOW });
  try {
    await s.call('POST', '/targets', { name: 'rex', url: URL_RAW });
    for (const age of [100, 50, 2]) await seedHistory(storage, 'rex', { okAgeH: age, now: NOW });
    const list = (await s.call('GET', '/targets/rex/backups')).json.backups;
    assert.equal(list.length, 3);
    assert.equal(list[0].newest, true);
    assert.ok(new Date(list[0].createdAt) > new Date(list[1].createdAt));
    const newest = list[0].key, oldest = list[2].key;

    const dl = await s.call('GET', `/backups/download-url?key=${encodeURIComponent(oldest)}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.json.expiresInSeconds, 600);
    assert.match(dl.json.url, /^http/);
    for (const bad of ['', 'vault/_vault/config.json', 'vault/rex/../_vault/config.json', 'other/rex/2026/06/rex-20260610T000000Z.dump', 'vault/rex/2026/06/hack-20260610T000000Z.dump']) {
      assert.equal((await s.call('GET', `/backups/download-url?key=${encodeURIComponent(bad)}`)).status, 400, bad);
    }
    assert.equal((await s.call('GET', `/backups/download-url?key=${encodeURIComponent('vault/rex/2026/06/rex-20200101T000000Z.dump')}`)).status, 404);

    const delNewest = await s.call('DELETE', `/backups?key=${encodeURIComponent(newest)}`);
    assert.equal(delNewest.status, 409);
    assert.ok(await storage.head(newest));
    const delOld = await s.call('DELETE', `/backups?key=${encodeURIComponent(oldest)}`);
    assert.equal(delOld.status, 200);
    assert.equal(await storage.head(oldest), null);
    assert.equal((await s.call('DELETE', `/backups?key=${encodeURIComponent('vault/_vault/config.json')}`)).status, 400);
    assert.ok(await storage.getText('vault/_vault/config.json'));
  } finally { await s.close(); }
});

test('bucket/test responds; runs listing honours limit', async () => {
  const NOW = Date.UTC(2026, 5, 10, 12);
  const storage = new MemoryStorage();
  const s = await boot({ storage, now: () => NOW });
  try {
    assert.equal((await s.call('POST', '/bucket/test')).json.ok, true);
    await s.call('POST', '/targets', { name: 'rex', url: URL_RAW });
    for (const age of [5, 4, 3, 2, 1]) await seedHistory(storage, 'rex', { okAgeH: age, now: NOW });
    const runs = (await s.call('GET', '/targets/rex/runs?limit=3')).json.runs;
    assert.equal(runs.length, 3);
    assert.ok(runs[0].startedAt > runs[1].startedAt, 'newest first');
    assert.equal((await s.call('GET', '/targets/ghost/runs')).status, 404);
  } finally { await s.close(); }
});

// ---------- scheduler with a stub runner and a fake clock ----------
function stubRunner(storage, log) {
  const calls = { active: 0, maxActive: 0, order: [] };
  const runner = async ({ target, now, trigger }) => {
    calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
    calls.order.push(target);
    await new Promise((r) => setTimeout(r, 40));
    calls.active--;
    const rec = { target, trigger, status: 'success', startedAt: new Date(now).toISOString(), finishedAt: new Date(now + 40).toISOString(), durationMs: 40, sizeBytes: 1, sha256: 'x', key: `k-${now}`, verified: true, error: null };
    await storage.putJson(`vault/_vault/runs/${target}/${msToTs(now)}.json`, rec);
    Object.defineProperty(rec, '_ts', { value: msToTs(now), enumerable: false });
    return rec;
  };
  return { runner, calls };
}

const waitIdle = async (v) => { for (let i = 0; i < 200 && (v.current || v.queue.length); i++) await new Promise((r) => setTimeout(r, 10)); };

test('scheduler: runs due targets one at a time, never twice, catches up after downtime', async () => {
  const storage = new MemoryStorage();
  let clock = Date.UTC(2026, 5, 10, 14, 0); // 08:00 Denver
  const { runner, calls } = stubRunner(storage);
  const s = await boot({ storage, now: () => clock, runner });
  try {
    for (const n of ['a', 'b', 'c']) await s.call('POST', '/targets', { name: n, url: URL_RAW, schedule: { type: 'daily', time: '03:00' } });
    await s.call('POST', '/targets', { name: 'off', url: URL_RAW, enabled: false });

    const q1 = await s.vault.tick();
    assert.deepEqual(q1.map((x) => x.name).sort(), ['a', 'b', 'c'], 'disabled target is skipped');
    const q1b = await s.vault.tick(); // same instant, jobs still in flight
    assert.equal(q1b.length, 0, 'no double queueing while queued/running');
    await waitIdle(s.vault);
    assert.equal(calls.order.length, 3);
    assert.equal(calls.maxActive, 1, 'global concurrency limit is 1');

    clock += 60_000;
    assert.equal((await s.vault.tick()).length, 0, 'already served today\'s slot');
    clock += 2 * 3_600_000; // 10:01 same day
    assert.equal((await s.vault.tick()).length, 0);

    // service "down" over the next 03:00 slot, back at 11:00 Denver next day => catch-up for all three
    clock = Date.UTC(2026, 5, 11, 17, 0);
    const q2 = await s.vault.tick();
    assert.equal(q2.length, 3);
    await waitIdle(s.vault);
    assert.equal(calls.order.length, 6);
    assert.equal(calls.maxActive, 1);
    assert.equal((await s.vault.tick()).length, 0);
  } finally { await s.close(); }

  // restart (new process, same bucket): history is read back, so nothing is run again
  const s2 = await boot({ storage, now: () => clock, runner: stubRunner(storage).runner });
  try {
    await s2.vault.ensureReady();
    assert.equal((await s2.vault.tick()).length, 0, 'restart must not trigger duplicate backups');
  } finally { await s2.close(); }
});

test('manual run: 202 + conflict if already queued; wait=true returns the record', async () => {
  const storage = new MemoryStorage();
  const { runner } = stubRunner(storage);
  const s = await boot({ storage, runner });
  try {
    await s.call('POST', '/targets', { name: 'a', url: URL_RAW });
    const r1 = await s.call('POST', '/targets/a/run');
    assert.equal(r1.status, 202);
    const r2 = await s.call('POST', '/targets/a/run');
    assert.equal(r2.status, 409);
    await waitIdle(s.vault);
    const r3 = await s.call('POST', '/targets/a/run?wait=true');
    assert.equal(r3.status, 200);
    assert.equal(r3.json.status, 'success');
    assert.equal((await s.call('POST', '/targets/ghost/run')).status, 404);
  } finally { await s.close(); }
});
