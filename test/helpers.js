import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { S3Storage } from '../src/storage.js';

const require = createRequire(import.meta.url);

export const S3_PORT = 4581;
export const API_PORT = 4580;

/** Starts the s3rver emulator on 4581 with a fresh empty bucket. */
export async function startS3Emulator(bucket = 'vault-test') {
  const S3rver = require('s3rver');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3rver-'));
  const srv = new S3rver({
    port: S3_PORT, address: '127.0.0.1', silent: true, directory: dir,
    configureBuckets: [{ name: bucket, configs: [] }],
    allowMismatchedSignatures: false,
  });
  await srv.run();
  return {
    endpoint: `http://127.0.0.1:${S3_PORT}`, bucket, dir,
    async close() { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

export function s3Config(emu, prefix = 'vault') {
  return { endpoint: emu.endpoint, region: 'us-east-1', bucket: emu.bucket, accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', prefix, forcePathStyle: true };
}

export function newStorage(emu, prefix) { return new S3Storage(s3Config(emu, prefix)); }

/** In-memory storage with the same interface as S3Storage (for fast unit/API tests). */
export class MemoryStorage {
  constructor() { this.objects = new Map(); this.calls = []; }
  async putJson(key, obj) { this.objects.set(key, { body: Buffer.from(JSON.stringify(obj)), lastModified: Date.now() }); }
  async getText(key) { const o = this.objects.get(key); return o ? o.body.toString('utf8') : null; }
  async getJson(key) { const t = await this.getText(key); return t == null ? null : JSON.parse(t); }
  async list(prefix) {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.length, lastModified: o.lastModified })).sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  async head(key) { const o = this.objects.get(key); return o ? { size: o.body.length } : null; }
  async delete(key) { this.calls.push(['delete', key]); this.objects.delete(key); }
  async upload(key, body) {
    const chunks = [];
    for await (const c of body) chunks.push(c);
    this.objects.set(key, { body: Buffer.concat(chunks), lastModified: Date.now() });
  }
  async presignGet(key) { return `http://memory.invalid/${key}?sig=fake`; }
  async selfTest() { return { ok: true, steps: { write: true, read: true, delete: true }, latencyMs: 1 }; }
}

export function baseEnv(over = {}) {
  return {
    port: API_PORT, tz: 'America/Denver', apiKey: 'test-api-key-0123456789', configKey: 'test-config-key-0123456789', encKey: undefined,
    seed: undefined, s3: { endpoint: undefined, region: 'us-east-1', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK-secret-value', prefix: 'vault', forcePathStyle: false },
    tmpDir: undefined, dumpTimeoutMs: 120_000, autoSchedule: false, pgDump: 'pg_dump', pgRestore: 'pg_restore', ...over,
  };
}
