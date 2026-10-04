// One backup run: pg_dump -Fc -> temp file -> pg_restore --list + sha256 -> (encrypt) -> multipart upload -> run record.
//
// Why a temp file instead of piping straight into the upload?  (1) the verification (pg_restore --list) must pass BEFORE
// anything is uploaded, (2) a dump written to a seekable file keeps the offsets that make `pg_restore -j` (parallel) possible,
// (3) a failed dump never leaves a half object in the bucket. The file is deleted right after the run (always).
// The upload itself IS streamed (8 MiB parts), so memory use stays small whatever the size.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import { redact, registerUrlSecrets } from './redact.js';
import { pgChildEnv, runProcess, binaryVersion } from './pg.js';
import { createEncryptStream } from './crypto.js';
import { msToTs } from './keys.js';

class StageError extends Error {
  constructor(stage, message) { super(message); this.stage = stage; }
}

function tail(s, n = 600) {
  // pg tools often repeat the same line twice: drop consecutive duplicates
  const lines = String(s || '').trim().split('\n').filter((l, i, a) => i === 0 || l !== a[i - 1]);
  const t = redact(lines.join('\n'));
  return t.length > n ? '…' + t.slice(-n) : t;
}

/**
 * @returns the run record (also persisted to the bucket). Never throws for backup failures; they are recorded.
 */
export async function executeBackup({ target, url, storage, keys, env, log, trigger = 'manual', now = Date.now(), lastTs = null }) {
  registerUrlSecrets(url);
  const startedMs = now;
  let ts = msToTs(startedMs);
  if (ts === lastTs) ts = msToTs(startedMs + 1000); // two runs in the same second must not share a key
  const d = new Date(startedMs);
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const encrypted = Boolean(env.encKey);
  const key = keys.dumpKey(target, ts, year, month, encrypted);
  const recordKey = keys.runKey(target, ts);

  const rec = {
    target, trigger, status: 'failed',
    startedAt: d.toISOString(), finishedAt: null, durationMs: null,
    sizeBytes: null, plaintextSizeBytes: null, sha256: null, storedSha256: null,
    key: null, encrypted, verified: false, pgDumpVersion: null, error: null,
  };
  let tmpDir, uploaded = false;
  let stage = 'prepare';
  try {
    const ver = await binaryVersion(env.pgDump);
    if (!ver) throw new StageError('prepare', `pg_dump not found (${env.pgDump}). Is postgresql-client installed in the image?`);
    rec.pgDumpVersion = ver.text;

    tmpDir = await fsp.mkdtemp(path.join(env.tmpDir || os.tmpdir(), 'bv-'));
    const file = path.join(tmpDir, 'dump.bin');
    const childEnv = pgChildEnv(url);

    stage = 'dump';
    log.info(`[${target}] pg_dump started (${trigger})`);
    const dump = await runProcess(env.pgDump, ['-Fc', '--no-password', '-f', file], { env: childEnv, timeoutMs: env.dumpTimeoutMs });
    if (dump.spawnError) throw new StageError('dump', `could not start pg_dump: ${dump.spawnError.message}`);
    if (dump.timedOut) throw new StageError('dump', `pg_dump exceeded the time limit (${Math.round(env.dumpTimeoutMs / 60000)} min)`);
    if (dump.code !== 0) {
      let msg = tail(dump.stderr) || `pg_dump exited with code ${dump.code}`;
      if (/server version mismatch|aborting because of server version/i.test(dump.stderr)) {
        msg += ' — pg_dump is older than the database server: rebuild the image with a newer postgresql-client (see README).';
      }
      throw new StageError('dump', msg);
    }

    stage = 'verify';
    const lst = await runProcess(env.pgRestore, ['--list', file], { env: { PATH: process.env.PATH }, timeoutMs: 120_000, maxOut: 50_000_000 });
    if (lst.code !== 0 || !/Archive created at|;\s*Format:\s*CUSTOM/i.test(lst.stdout) ) {
      throw new StageError('verify', `the dump is not readable by pg_restore --list: ${tail(lst.stderr) || 'unexpected output'}`);
    }
    const entries = lst.stdout.split('\n').filter((l) => l && !l.startsWith(';')).length;
    if (entries === 0) throw new StageError('verify', 'the dump has no objects in its table of contents (empty database?)');
    rec.verified = true;

    const { sha256, size } = await hashFile(file);
    rec.sha256 = sha256;
    rec.plaintextSizeBytes = size;

    stage = 'upload';
    log.info(`[${target}] uploading ${size} bytes${encrypted ? ' (encrypted)' : ''} to ${key}`);
    const counter = { bytes: 0, hash: crypto.createHash('sha256') };
    const tap = new Transform({
      transform(chunk, _e, cb) { counter.bytes += chunk.length; counter.hash.update(chunk); cb(null, chunk); },
    });
    const stages = [fs.createReadStream(file), ...(encrypted ? [createEncryptStream(env.encKey)] : []), tap];
    pipeline(...stages, () => {}); // errors destroy every stage, so the upload below fails instead of hanging
    await storage.upload(key, tap, { contentType: 'application/octet-stream' });
    uploaded = true;
    rec.sizeBytes = counter.bytes;
    rec.storedSha256 = counter.hash.digest('hex');
    const head = await storage.head(key);
    if (!head || head.size !== counter.bytes) throw new StageError('upload', `uploaded object size mismatch (bucket reports ${head?.size ?? 'missing'}, sent ${counter.bytes})`);

    rec.key = key;
    rec.status = 'success';
  } catch (e) {
    rec.status = 'failed';
    rec.error = tail(`${e.stage || stage}: ${e.message}`, 1200);
    rec.key = null;
    if (uploaded) { try { await storage.delete(key); } catch { /* best effort */ } }
  } finally {
    if (tmpDir) fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  const fin = Date.now();
  rec.finishedAt = new Date(Math.max(fin, startedMs)).toISOString();
  rec.durationMs = Math.max(0, fin - startedMs);
  try {
    await storage.putJson(recordKey, rec);
  } catch (e) {
    log.error(`[${target}] could not write run record: ${e.message}`);
  }
  if (rec.status === 'success') log.info(`[${target}] backup OK ${rec.sizeBytes} bytes in ${rec.durationMs} ms -> ${key}`);
  else log.error(`[${target}] backup FAILED: ${rec.error}`);
  Object.defineProperty(rec, '_ts', { value: ts, enumerable: false });
  return rec;
}

async function hashFile(file) {
  const h = crypto.createHash('sha256');
  let size = 0;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => { size += c.length; h.update(c); });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  return { sha256: h.digest('hex'), size };
}
