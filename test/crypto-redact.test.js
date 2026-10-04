import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { encryptString, decryptString, createEncryptStream, createDecryptStream, looksEncrypted } from '../src/crypto.js';
import { redact, redactUrl, registerSecret, registerUrlSecrets, clearSecrets } from '../src/redact.js';
import { ConfigStore } from '../src/configStore.js';
import { MemoryStorage } from './helpers.js';
import { createLogger } from '../src/logger.js';

const URL1 = 'postgres://crm_user:S3cr3t%21pw@rex-db:5432/rex';

test('config string encryption round trip (passphrase and raw hex key)', () => {
  for (const key of ['a long passphrase with spaces', crypto.randomBytes(32).toString('hex')]) {
    const enc = encryptString(URL1, key);
    assert.match(enc, /^bvc1:/);
    assert.ok(!enc.includes('S3cr3t'));
    assert.equal(decryptString(enc, key), URL1);
    assert.notEqual(encryptString(URL1, key), enc, 'random IV/salt each time');
  }
});

test('config string: wrong key and tampering are detected', () => {
  const enc = encryptString('hello', 'key-one-key-one-key');
  assert.throws(() => decryptString(enc, 'key-two-key-two-key'), /cannot decrypt/);
  const buf = Buffer.from(enc.slice(5), 'base64url');
  buf[buf.length - 1] ^= 1;
  assert.throws(() => decryptString('bvc1:' + buf.toString('base64url'), 'key-one-key-one-key'), /cannot decrypt/);
  assert.throws(() => decryptString('plain', 'k'), /not an encrypted/);
});

async function roundTrip(data, key, chunkSize) {
  const enc = [];
  await pipeline(Readable.from([data]), createEncryptStream(key, { chunkSize }), async function* (s) { for await (const c of s) enc.push(c); });
  const encrypted = Buffer.concat(enc);
  const dec = [];
  await pipeline(Readable.from([encrypted]), createDecryptStream(key), async function* (s) { for await (const c of s) dec.push(c); });
  return { encrypted, decrypted: Buffer.concat(dec) };
}

test('file stream encryption round trip across sizes and chunk boundaries', async () => {
  for (const [size, chunk] of [[0, 1024], [1, 1024], [1024, 1024], [1025, 1024], [5000, 1024], [300_000, 65536]]) {
    const data = crypto.randomBytes(size);
    const { encrypted, decrypted } = await roundTrip(data, 'file-key-file-key-1234', chunk);
    assert.ok(looksEncrypted(encrypted));
    assert.ok(decrypted.equals(data), `size ${size}`);
    if (size > 100) assert.ok(!encrypted.includes(data.subarray(0, 64)), 'no plaintext leaks');
  }
});

test('file stream decryption: wrong key, tamper, truncation, reorder, trailing garbage', async () => {
  const data = crypto.randomBytes(20_000);
  const { encrypted } = await roundTrip(data, 'file-key-file-key-1234', 4096);
  const run = (buf, key = 'file-key-file-key-1234') => pipeline(Readable.from([buf]), createDecryptStream(key), async function* (s) { for await (const _ of s); });
  await assert.rejects(run(encrypted, 'another-key-another-key'), /wrong key|tampered/);
  const t = Buffer.from(encrypted); t[100] ^= 0xff;
  await assert.rejects(run(t), /wrong key|tampered/);
  await assert.rejects(run(encrypted.subarray(0, encrypted.length - 5000)), /truncated|incomplete|wrong key|tampered/);
  await assert.rejects(run(encrypted.subarray(0, 33 + 4 + 4096 + 16)), /truncated/); // whole first frame only, final missing
  await assert.rejects(run(Buffer.concat([encrypted, Buffer.from('xx')])), /unexpected data|wrong key/);
  await assert.rejects(run(Buffer.from('this is not encrypted at all, just text........')), /not a backup-vault/);
  await assert.rejects(run(Buffer.alloc(0)), /empty or truncated/);
});

test('decrypt works when input arrives in tiny pieces', async () => {
  const data = crypto.randomBytes(10_000);
  const { encrypted } = await roundTrip(data, 'file-key-file-key-1234', 1000);
  const pieces = []; for (let i = 0; i < encrypted.length; i += 7) pieces.push(encrypted.subarray(i, i + 7));
  const out = [];
  await pipeline(Readable.from(pieces), createDecryptStream('file-key-file-key-1234'), async function* (s) { for await (const c of s) out.push(c); });
  assert.ok(Buffer.concat(out).equals(data));
});

test('redactUrl hides the password but keeps the rest', () => {
  assert.equal(redactUrl(URL1), 'postgres://crm_user:***@rex-db:5432/rex');
  assert.equal(redactUrl('postgresql://u:p@h/db?sslmode=require'), 'postgresql://u:***@h/db?sslmode=require');
  assert.equal(redactUrl('postgres://onlyuser@h:5432/db'), 'postgres://onlyuser@h:5432/db');
  assert.equal(redactUrl('postgres://u:p%40ss@h/db'), 'postgres://u:***@h/db');
  assert.ok(!redactUrl('not a url but postgres://a:pw123@x/y').includes('pw123'));
});

test('redact() scrubs registered secrets, URL credentials and key=value pairs', () => {
  clearSecrets();
  registerUrlSecrets(URL1);
  registerSecret('B2-super-secret-key');
  const msg = 'connect failed for postgres://crm_user:S3cr3t%21pw@rex-db:5432/rex (pw S3cr3t!pw) key=B2-super-secret-key PGPASSWORD=abc123 other://x:y@z';
  const out = redact(msg);
  for (const bad of ['S3cr3t', 'B2-super-secret-key', 'abc123', ':y@']) assert.ok(!out.includes(bad), `${bad} leaked: ${out}`);
  assert.match(out, /rex-db:5432\/rex/);
  assert.equal(redact('password authentication failed for user "x"'), 'password authentication failed for user "x"');
  clearSecrets();
});

test('logger redacts everything it prints', () => {
  clearSecrets();
  registerSecret('TOPSECRET-VALUE');
  const lines = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  log.info('hello TOPSECRET-VALUE', { url: 'postgres://u:pw999@h/db' });
  assert.ok(!lines.join('\n').includes('TOPSECRET-VALUE') && !lines.join('\n').includes('pw999'));
  clearSecrets();
});

test('config store: urls are encrypted at rest in the bucket, views are redacted, wrong key locks writes', async () => {
  const storage = new MemoryStorage();
  const log = createLogger({ quiet: true });
  const store = new ConfigStore({ storage, key: 'vault/_vault/config.json', secret: 'config-key-config-key', log });
  await store.load();
  await store.mutate((t) => { t.push(store.build({ name: 'rex', url: URL1, schedule: { type: 'daily', time: '03:00' }, retention: { daily: 7, weekly: 4, monthly: 6 } })); });
  const raw = await storage.getText('vault/_vault/config.json');
  assert.ok(!raw.includes('S3cr3t') && !raw.includes('rex-db'), 'URL must be encrypted in the stored JSON');
  assert.match(JSON.parse(raw).targets[0].url, /^bvc1:/);
  assert.equal(store.view(store.get('rex')).url, 'postgres://crm_user:***@rex-db:5432/rex');
  assert.equal(store.urlOf(store.get('rex')), URL1);
  // reload with the right key
  const s2 = new ConfigStore({ storage, key: 'vault/_vault/config.json', secret: 'config-key-config-key', log });
  await s2.load();
  assert.equal(s2.locked, null);
  assert.equal(s2.urlOf(s2.get('rex')), URL1);
  // reload with the wrong key: locked, cannot write
  const s3 = new ConfigStore({ storage, key: 'vault/_vault/config.json', secret: 'WRONG-config-key-xxxx', log });
  await s3.load();
  assert.ok(s3.locked);
  await assert.rejects(s3.mutate((t) => t.pop()), /BACKUP_CONFIG_KEY/);
  assert.match(s3.view(s3.get('rex')).url, /cannot decrypt/);
  assert.equal(await storage.getText('vault/_vault/config.json'), raw, 'stored config untouched');
});
