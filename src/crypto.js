// AES-256-GCM helpers (node:crypto only, no dependencies).
//  1. encryptString / decryptString : small values (connection URLs inside _vault/config.json)
//  2. createEncryptStream / createDecryptStream : whole dump files, chunked + authenticated
import crypto from 'node:crypto';
import { Transform } from 'node:stream';

const keyCache = new Map();

/** 64 hex chars => used as raw 256-bit key; anything else => scrypt(secret, salt). */
export function deriveKey(secret, salt) {
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('missing encryption secret');
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex');
  const ck = secret + '|' + salt.toString('hex');
  let k = keyCache.get(ck);
  if (!k) {
    k = crypto.scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
    keyCache.set(ck, k);
    if (keyCache.size > 64) keyCache.delete(keyCache.keys().next().value);
  }
  return k;
}

// ---------- small strings (config) ----------
const STR_PREFIX = 'bvc1:';

export function encryptString(plain, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return STR_PREFIX + Buffer.concat([salt, iv, c.getAuthTag(), ct]).toString('base64url');
}

export function decryptString(enc, secret) {
  if (typeof enc !== 'string' || !enc.startsWith(STR_PREFIX)) throw new Error('not an encrypted value');
  const buf = Buffer.from(enc.slice(STR_PREFIX.length), 'base64url');
  if (buf.length < 16 + 12 + 16) throw new Error('encrypted value is truncated');
  const salt = buf.subarray(0, 16), iv = buf.subarray(16, 28), tag = buf.subarray(28, 44), ct = buf.subarray(44);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    throw new Error('cannot decrypt (wrong key or corrupted data)');
  }
}

// ---------- files (dumps) ----------
// Layout: MAGIC "BVLT"(4) | version(1)=1 | chunkSize u32 | salt(16) | noncePrefix(8)   = 33 bytes header
// then frames: u32 (len | FINAL_BIT) | ciphertext(len) | tag(16)
// IV = noncePrefix(8) + counter u32; AAD = header + final-flag byte -> reordering, truncation, tampering all detected.
export const MAGIC = Buffer.from('BVLT');
const HEADER_LEN = 33;
const FINAL_BIT = 0x80000000;
const TAG_LEN = 16;
export const DEFAULT_CHUNK = 1 << 20;

export function looksEncrypted(buf) {
  return buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC);
}

function frameIv(prefix, counter) {
  const iv = Buffer.alloc(12);
  prefix.copy(iv, 0);
  iv.writeUInt32BE(counter >>> 0, 8);
  return iv;
}

export function createEncryptStream(secret, { chunkSize = DEFAULT_CHUNK } = {}) {
  const salt = crypto.randomBytes(16);
  const noncePrefix = crypto.randomBytes(8);
  const key = deriveKey(secret, salt);
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(1, 4);
  header.writeUInt32BE(chunkSize, 5);
  salt.copy(header, 9);
  noncePrefix.copy(header, 25);
  let pending = [];
  let pendingLen = 0;
  let counter = 0;

  const seal = (plain, final) => {
    const c = crypto.createCipheriv('aes-256-gcm', key, frameIv(noncePrefix, counter++));
    c.setAAD(Buffer.concat([header, Buffer.from([final ? 1 : 0])]));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE((ct.length | (final ? FINAL_BIT : 0)) >>> 0, 0);
    return Buffer.concat([len, ct, c.getAuthTag()]);
  };

  const t = new Transform({
    transform(chunk, _enc, cb) {
      try {
        pending.push(chunk);
        pendingLen += chunk.length;
        // always keep >= 1 byte back so the last frame can be flagged final
        while (pendingLen > chunkSize) {
          const all = Buffer.concat(pending);
          this.push(seal(all.subarray(0, chunkSize), false));
          const rest = all.subarray(chunkSize);
          pending = [rest];
          pendingLen = rest.length;
        }
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        this.push(seal(Buffer.concat(pending), true));
        cb();
      } catch (e) { cb(e); }
    },
  });
  t.push(header);
  return t;
}

export function createDecryptStream(secret) {
  let buf = Buffer.alloc(0);
  let header = null, key = null, noncePrefix = null, chunkSize = 0;
  let counter = 0, finished = false;

  const t = new Transform({
    transform(chunk, _enc, cb) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        if (finished && buf.length) throw new Error('unexpected data after the final block (corrupted file)');
        if (!header) {
          if (buf.length < HEADER_LEN) return cb();
          if (!looksEncrypted(buf)) throw new Error('not a backup-vault encrypted file (bad magic header)');
          if (buf.readUInt8(4) !== 1) throw new Error('unsupported encryption format version');
          header = Buffer.from(buf.subarray(0, HEADER_LEN));
          chunkSize = header.readUInt32BE(5);
          key = deriveKey(secret, header.subarray(9, 25));
          noncePrefix = header.subarray(25, 33);
          buf = buf.subarray(HEADER_LEN);
        }
        while (buf.length >= 4) {
          const raw = buf.readUInt32BE(0);
          const final = (raw & FINAL_BIT) !== 0;
          const len = raw & ~FINAL_BIT;
          if (len > chunkSize) throw new Error('corrupted file (block too large)');
          if (buf.length < 4 + len + TAG_LEN) break;
          const ct = buf.subarray(4, 4 + len);
          const tag = buf.subarray(4 + len, 4 + len + TAG_LEN);
          const d = crypto.createDecipheriv('aes-256-gcm', key, frameIv(noncePrefix, counter++));
          d.setAAD(Buffer.concat([header, Buffer.from([final ? 1 : 0])]));
          d.setAuthTag(tag);
          let plain;
          try { plain = Buffer.concat([d.update(ct), d.final()]); }
          catch { throw new Error('decryption failed: wrong key or corrupted/tampered file'); }
          this.push(plain);
          buf = buf.subarray(4 + len + TAG_LEN);
          if (final) { finished = true; if (buf.length) throw new Error('unexpected data after the final block (corrupted file)'); break; }
        }
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      if (!header) return cb(new Error('empty or truncated file'));
      if (!finished) return cb(new Error('file is truncated (final block missing)'));
      cb();
    },
  });
  return t;
}
