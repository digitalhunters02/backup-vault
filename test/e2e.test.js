// End-to-end: real PostgreSQL + S3 emulator (s3rver on :4581) + the real HTTP service on :4580.
// Needs a local Postgres with user test/test (override with TEST_PG_ADMIN_URL). Skipped (loudly) if Postgres is unreachable.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { buildService } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { clearSecrets, registerSecret } from '../src/redact.js';
import { startS3Emulator, newStorage, baseEnv, API_PORT } from './helpers.js';

const ADMIN = process.env.TEST_PG_ADMIN_URL || 'postgres://test:test@localhost:5432/postgres';
const mkUrl = (db, user = 'test', pass = 'test') => { const u = new URL(ADMIN); u.username = user; u.password = pass; u.pathname = '/' + db; return u.toString(); };
const SRC = mkUrl('vault_src');
const KEY = 'e2e-api-key-0123456789abc';
const ENC_KEY = 'e2e-encryption-key-very-secret-123';
const TABLES = ['customers', 'orders', 'events'];
const ROOT = new URL('..', import.meta.url).pathname;

let pgOk = false, emu, tmpRoot;

async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function fingerprint(url) {
  return withClient(url, async (c) => {
    const out = {};
    for (const t of TABLES) {
      out[t] = Number((await c.query(`select count(*) n from ${t}`)).rows[0].n);
    }
    out.checksum = (await c.query("select md5(string_agg(id::text||name||coalesce(email,''), ',' order by id)) h from customers")).rows[0].h;
    out.orderSum = (await c.query('select sum(total)::text s from orders')).rows[0].s;
    out.view = Number((await c.query('select count(*) n from big_orders')).rows[0].n);
    return out;
  });
}

before(async () => {
  try {
    await withClient(ADMIN, async (a) => {
      await a.query('select 1');
      for (const db of ['vault_src', 'vault_restore']) {
        await a.query(`drop database if exists ${db} with (force)`);
        await a.query(`create database ${db}`);
      }
    });
    await withClient(SRC, async (c) => {
      await c.query(`
        create table customers(id serial primary key, name text not null, email text, created_at timestamptz default now());
        create table orders(id serial primary key, customer_id int references customers(id), total numeric(12,2), notes text);
        create table events(id bigserial primary key, kind text, payload jsonb);
        insert into customers(name,email) select 'Customer '||g, 'c'||g||'@example.com' from generate_series(1,3000) g;
        insert into orders(customer_id,total,notes) select (g%3000)+1, ((g*37)%1000)::numeric(12,2), repeat('x', 20) from generate_series(1,8000) g;
        insert into events(kind,payload) select 'k'||(g%7), jsonb_build_object('n',g,'t',md5(g::text)) from generate_series(1,5000) g;
        create view big_orders as select * from orders where total>500;`);
    });
    pgOk = true;
  } catch (e) {
    console.error(`# E2E SKIPPED: PostgreSQL not reachable at ${ADMIN.replace(/:[^:@]*@/, ':***@')}: ${e.message}`);
  }
  emu = await startS3Emulator();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-e2e-'));
});

after(async () => {
  await emu?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let n = 0;
async function boot({ encKey, prefix = `e2e${++n}` } = {}) {
  clearSecrets(); registerSecret(KEY);
  const lines = [];
  const env = baseEnv({
    apiKey: KEY, encKey, tmpDir: tmpRoot, tz: 'America/Denver',
    s3: { endpoint: emu.endpoint, region: 'us-east-1', bucket: emu.bucket, accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', prefix, forcePathStyle: true },
  });
  const svc = buildService(env, { log: createLogger({ sink: (l) => lines.push(l) }) });
  await new Promise((r) => svc.server.listen(API_PORT, '127.0.0.1', r));
  const storage = newStorage(emu, prefix);
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${API_PORT}${p}`, { method, headers: { 'X-Backup-Key': KEY, 'Content-Type': 'application/json', Connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  return { svc, env, storage, prefix, lines, call, close: () => new Promise((r) => { svc.server.close(r); svc.server.closeAllConnections?.(); }) };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const skipUnlessPg = () => !pgOk && { skip: 'PostgreSQL not available' };

async function download(call, key) {
  const dl = await call('GET', `/backups/download-url?key=${encodeURIComponent(key)}`);
  assert.equal(dl.status, 200, dl.text);
  const res = await fetch(dl.json.url);
  assert.equal(res.status, 200);
  return Buffer.from(await res.arrayBuffer());
}

function restoreInto(file) {
  const r = spawnSync('pg_restore', ['--no-owner', '--exit-on-error', '-d', mkUrl('vault_restore'), file], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'pg_restore failed: ' + r.stderr);
}

async function resetRestoreDb() {
  await withClient(ADMIN, async (a) => {
    await a.query('drop database if exists vault_restore with (force)');
    await a.query('create database vault_restore');
  });
}

test('E2E plain: backup -> bucket -> download -> pg_restore -> same data', async (t) => {
  if (!pgOk) return t.skip('PostgreSQL not available');
  const s = await boot();
  try {
    assert.equal((await s.call('POST', '/bucket/test')).json.ok, true);

    const created = await s.call('POST', '/targets', { name: 'src', url: SRC, retention: { daily: 7, weekly: 4, monthly: 6 } });
    assert.equal(created.status, 201);
    assert.equal(created.json.url, 'postgres://test:***@localhost:5432/vault_src');

    const tst = await s.call('POST', '/targets/src/test');
    assert.equal(tst.status, 200);
    assert.equal(tst.json.ok, true, tst.text);
    assert.equal(tst.json.connect, true);
    assert.equal(tst.json.schemaDump, true);
    assert.equal(tst.json.serverMajor, 16);
    assert.ok(!tst.text.includes('test:test'));

    const run = await s.call('POST', '/targets/src/run?wait=true');
    assert.equal(run.status, 200);
    const rec = run.json;
    assert.equal(rec.status, 'success', rec.error);
    assert.equal(rec.verified, true);
    assert.equal(rec.encrypted, false);
    assert.match(rec.sha256, /^[0-9a-f]{64}$/);
    assert.match(rec.key, new RegExp(`^${s.prefix}/src/\\d{4}/\\d{2}/src-\\d{8}T\\d{6}Z\\.dump$`));
    assert.ok(rec.sizeBytes > 10_000 && rec.durationMs >= 0 && rec.error === null);

    // the object and its run record are in the bucket, nothing else leaked (config is encrypted)
    const objs = await s.storage.list(`${s.prefix}/`);
    assert.ok(objs.some((o) => o.key === rec.key && o.size === rec.sizeBytes));
    assert.ok(objs.some((o) => o.key.startsWith(`${s.prefix}/_vault/runs/src/`) && o.key.endsWith('.json')));
    const cfg = await s.storage.getText(`${s.prefix}/_vault/config.json`);
    assert.ok(!cfg.includes('test:test') && !cfg.includes('localhost'), 'config must not contain the plaintext URL');

    const list = (await s.call('GET', '/targets/src/backups')).json.backups;
    assert.equal(list.length, 1);
    assert.equal(list[0].key, rec.key);
    const runs = (await s.call('GET', '/targets/src/runs?limit=5')).json.runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].sha256, rec.sha256);

    const st = (await s.call('GET', '/status?refresh=true')).json;
    assert.equal(st.status, 'healthy');
    assert.equal(st.targets[0].lastSuccess.key, rec.key);
    assert.ok(st.totalStoredBytes >= rec.sizeBytes);

    // download via the presigned URL, integrity, restore, compare
    const bytes = await download(s.call, rec.key);
    assert.equal(bytes.length, rec.sizeBytes);
    assert.equal(sha256(bytes), rec.sha256);
    assert.equal(bytes.subarray(0, 5).toString(), 'PGDMP');
    const file = path.join(tmpRoot, 'plain.dump');
    fs.writeFileSync(file, bytes);
    await resetRestoreDb();
    restoreInto(file);
    const [a, b] = [await fingerprint(SRC), await fingerprint(mkUrl('vault_restore'))];
    assert.deepEqual(b, a);
    assert.equal(a.customers, 3000); assert.equal(a.orders, 8000); assert.equal(a.events, 5000);

    // no temp files left behind
    assert.deepEqual(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('bv-')), []);
  } finally { await s.close(); }
});

test('E2E encrypted: .enc object is ciphertext; scripts/decrypt.mjs + pg_restore gives identical data', async (t) => {
  if (!pgOk) return t.skip('PostgreSQL not available');
  const s = await boot({ encKey: ENC_KEY });
  try {
    await s.call('POST', '/targets', { name: 'src', url: SRC });
    const rec = (await s.call('POST', '/targets/src/run?wait=true')).json;
    assert.equal(rec.status, 'success', rec.error);
    assert.equal(rec.encrypted, true);
    assert.equal(rec.verified, true);
    assert.match(rec.key, /\.dump\.enc$/);

    const enc = await download(s.call, rec.key);
    assert.equal(enc.length, rec.sizeBytes);
    assert.equal(sha256(enc), rec.storedSha256, 'stored bytes hash matches');
    assert.equal(enc.subarray(0, 4).toString(), 'BVLT');
    assert.ok(!enc.includes(Buffer.from('PGDMP')), 'no plaintext archive header in the encrypted object');
    assert.ok(!enc.includes(Buffer.from('Customer 1')), 'no plaintext row data in the encrypted object');
    assert.ok(rec.sizeBytes > rec.plaintextSizeBytes && rec.sizeBytes < rec.plaintextSizeBytes + 4096);

    const encFile = path.join(tmpRoot, 'x.dump.enc');
    fs.writeFileSync(encFile, enc);
    // wrong key must fail and leave no output
    const bad = spawnSync('node', ['scripts/decrypt.mjs', encFile, path.join(tmpRoot, 'bad.dump')], { cwd: ROOT, env: { PATH: process.env.PATH, BACKUP_ENCRYPTION_KEY: 'a-completely-wrong-key-123' }, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /wrong key|tampered/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'bad.dump')), false);
    // right key
    const outFile = path.join(tmpRoot, 'x.dump');
    const ok = spawnSync('node', ['scripts/decrypt.mjs', encFile], { cwd: ROOT, env: { PATH: process.env.PATH, BACKUP_ENCRYPTION_KEY: ENC_KEY }, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.includes(rec.sha256), 'decrypt script prints the same sha256 as the run record');
    assert.equal(sha256(fs.readFileSync(outFile)), rec.sha256);

    await resetRestoreDb();
    restoreInto(outFile);
    assert.deepEqual(await fingerprint(mkUrl('vault_restore')), await fingerprint(SRC));
  } finally { await s.close(); }
});

test('E2E failure handling: wrong password / bad host / missing db -> failed run recorded, no secret anywhere', async (t) => {
  if (!pgOk) return t.skip('PostgreSQL not available');
  const s = await boot();
  const BADPASS = 'Wr0ngPassw0rd-XYZ';
  try {
    registerSecret(BADPASS);
    const cases = {
      wrongpw: mkUrl('vault_src', 'test', BADPASS),
      nodb: mkUrl('does_not_exist_db', 'test', 'test'),
      nohost: `postgres://test:${BADPASS}@127.0.0.1:1/vault_src`,
    };
    for (const [name, url] of Object.entries(cases)) {
      assert.equal((await s.call('POST', '/targets', { name, url })).status, 201);
      const tst = await s.call('POST', `/targets/${name}/test`);
      assert.equal(tst.json.ok, false);
      assert.ok(tst.json.error);
      assert.ok(!tst.text.includes(BADPASS), 'test endpoint leaked the password');
      const run = await s.call('POST', `/targets/${name}/run?wait=true`);
      assert.equal(run.status, 200);
      assert.equal(run.json.status, 'failed', name);
      assert.equal(run.json.key, null);
      assert.equal(run.json.verified, false);
      assert.ok(run.json.error && run.json.error.length > 5);
      assert.ok(!run.text.includes(BADPASS), 'run response leaked the password');
      // stored record
      const stored = (await s.storage.list(`${s.prefix}/_vault/runs/${name}/`));
      assert.equal(stored.length, 1);
      assert.ok(!(await s.storage.getText(stored[0].key)).includes(BADPASS));
      // no dump object was uploaded
      assert.equal((await s.call('GET', `/targets/${name}/backups`)).json.backups.length, 0);
    }
    const wrong = (await s.call('GET', '/targets/wrongpw/runs')).json.runs[0];
    assert.match(wrong.error, /password authentication failed|authentication/i);
    const st = (await s.call('GET', '/status')).json;
    assert.equal(st.status, 'failing');
    assert.ok(st.targets.every((x) => x.status === 'failing'));
    assert.ok(!JSON.stringify(st).includes(BADPASS));
    const all = s.lines.join('\n');
    assert.ok(all.includes('backup FAILED'), 'failures are logged');
    assert.ok(!all.includes(BADPASS), 'password leaked into the logs');
    assert.ok(!all.includes('test:test@'), 'URL credentials leaked into the logs');
    assert.deepEqual(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('bv-')), [], 'temp dirs cleaned after failures');
  } finally { await s.close(); }
});

test('E2E retention: runs are pruned by policy, newest always survives, run records follow', async (t) => {
  if (!pgOk) return t.skip('PostgreSQL not available');
  const s = await boot();
  try {
    await s.call('POST', '/targets', { name: 'src', url: SRC, retention: { daily: 1, weekly: 0, monthly: 0 } });
    const keys = [];
    for (let i = 0; i < 3; i++) {
      const r = (await s.call('POST', '/targets/src/run?wait=true')).json;
      assert.equal(r.status, 'success', r.error);
      keys.push(r.key);
      await new Promise((res) => setTimeout(res, 1100)); // distinct second => distinct object key
    }
    assert.equal(new Set(keys).size, 3);
    const left = (await s.call('GET', '/targets/src/backups')).json.backups;
    assert.equal(left.length, 1, 'daily=1 keeps one backup per the last 1 day');
    assert.equal(left[0].key, keys[2], 'the newest one survives');
    const recs = await s.storage.list(`${s.prefix}/_vault/runs/src/`);
    assert.equal(recs.length, 1, 'run records of pruned backups are removed too');
    // a second guard: manual delete of the newest is refused
    assert.equal((await s.call('DELETE', `/backups?key=${encodeURIComponent(keys[2])}`)).status, 409);
  } finally { await s.close(); }
});

test('E2E stateless restart + scheduler: new process on the same bucket knows targets/history and does not re-run', async (t) => {
  if (!pgOk) return t.skip('PostgreSQL not available');
  const prefix = 'e2e-stateless';
  const s = await boot({ prefix });
  let key;
  try {
    await s.call('POST', '/targets', { name: 'src', url: SRC, schedule: { type: 'daily', time: '03:00' } });
    // scheduler picks the never-backed-up target immediately (no manual run involved)
    const queued = await s.svc.vault.tick();
    assert.equal(queued.length, 1);
    assert.equal((await s.svc.vault.tick()).length, 0, 'no double run while in flight');
    const rec = await queued[0].job.promise;
    assert.equal(rec.status, 'success', rec.error);
    assert.equal(rec.trigger, 'schedule');
    key = rec.key;
    assert.equal((await s.svc.vault.tick()).length, 0, 'slot already served');
  } finally { await s.close(); }

  const s2 = await boot({ prefix }); // "rebuild": same bucket, nothing else
  try {
    const targets = (await s2.call('GET', '/targets')).json.targets;
    assert.equal(targets.length, 1);
    assert.equal(targets[0].url, 'postgres://test:***@localhost:5432/vault_src');
    const st = (await s2.call('GET', '/status')).json;
    assert.equal(st.targets[0].lastSuccess.key, key);
    assert.equal(st.status, 'healthy');
    assert.equal((await s2.svc.vault.tick()).length, 0, 'restart must not trigger another backup');
    // and it can still back up using the decrypted stored URL
    assert.equal((await s2.call('POST', '/targets/src/run?wait=true')).json.status, 'success');
    // wrong BACKUP_CONFIG_KEY: runs fail clearly, config untouched
  } finally { await s2.close(); }
});

test('E2E wrong BACKUP_CONFIG_KEY: service refuses to write and records a clear failure', async (t) => {
  if (!pgOk) return t.skip('PostgreSQL not available');
  const prefix = 'e2e-wrongkey';
  const s = await boot({ prefix });
  await s.call('POST', '/targets', { name: 'src', url: SRC });
  await s.close();
  const before = await newStorage(emu, prefix).getText(`${prefix}/_vault/config.json`);

  clearSecrets(); registerSecret(KEY);
  const lines = [];
  const env = baseEnv({ apiKey: KEY, configKey: 'a-different-config-key-999', tmpDir: tmpRoot, s3: { endpoint: emu.endpoint, region: 'us-east-1', bucket: emu.bucket, accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', prefix, forcePathStyle: true } });
  const svc = buildService(env, { log: createLogger({ sink: (l) => lines.push(l) }) });
  await new Promise((r) => svc.server.listen(API_PORT, '127.0.0.1', r));
  const call = async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${API_PORT}${p}`, { method: m, headers: { 'X-Backup-Key': KEY, 'Content-Type': 'application/json', Connection: 'close' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json() }; };
  try {
    assert.equal((await call('POST', '/targets', { name: 'new', url: SRC })).status, 409);
    const run = await call('POST', '/targets/src/run?wait=true');
    assert.equal(run.json.status, 'failed');
    assert.match(run.json.error, /BACKUP_CONFIG_KEY/);
    assert.equal((await call('GET', '/status')).json.configLocked !== null, true);
    assert.equal(await newStorage(emu, prefix).getText(`${prefix}/_vault/config.json`), before, 'config in bucket untouched');
  } finally { await new Promise((r) => { svc.server.close(r); svc.server.closeAllConnections?.(); }); }
});

test('E2E large dump (> 3 multipart parts) with encryption: streamed upload, byte-exact after decrypt', async (t) => {
  if (!pgOk) return t.skip('PostgreSQL not available');
  const big = mkUrl('vault_big');
  await withClient(ADMIN, async (a) => { await a.query('drop database if exists vault_big with (force)'); await a.query('create database vault_big'); });
  await withClient(big, (c) => c.query("create table t as select g id, md5(random()::text)||md5(random()::text)||md5(random()::text) a, md5(random()::text) b from generate_series(1,400000) g"));
  const s = await boot({ encKey: ENC_KEY });
  try {
    await s.call('POST', '/targets', { name: 'big', url: big });
    const rec = (await s.call('POST', '/targets/big/run?wait=true')).json;
    assert.equal(rec.status, 'success', rec.error);
    assert.ok(rec.plaintextSizeBytes > 24 * 1024 * 1024, `dump only ${rec.plaintextSizeBytes} bytes, wanted > 3 parts of 8 MiB`);
    const enc = await download(s.call, rec.key);
    assert.equal(enc.length, rec.sizeBytes);
    const { createDecryptStream } = await import('../src/crypto.js');
    const { Readable } = await import('node:stream');
    const h = crypto.createHash('sha256');
    for await (const chunk of Readable.from([enc]).pipe(createDecryptStream(ENC_KEY))) h.update(chunk);
    assert.equal(h.digest('hex'), rec.sha256);
  } finally {
    await s.close();
    await withClient(ADMIN, (a) => a.query('drop database if exists vault_big with (force)'));
  }
});
