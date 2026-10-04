// _vault/config.json in the bucket. Connection URLs are stored AES-256-GCM encrypted (BACKUP_CONFIG_KEY).
import { encryptString, decryptString } from './crypto.js';
import { DEFAULT_RETENTION } from './config.js';
import { NAME_RE } from './keys.js';
import { validateSchedule, normalizeSchedule } from './schedule.js';
import { parsePgUrl } from './pg.js';
import { registerUrlSecrets, redactUrl } from './redact.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const CHECK_PLAIN = 'backup-vault-config-v1';

export function validateRetention(r) {
  const out = { ...DEFAULT_RETENTION, ...(r || {}) };
  for (const k of ['daily', 'weekly', 'monthly']) {
    if (!Number.isInteger(out[k]) || out[k] < 0 || out[k] > 3650) throw new HttpError(400, `retention.${k} must be an integer between 0 and 3650`);
  }
  if (out.daily < 1) throw new HttpError(400, 'retention.daily must be at least 1');
  return { daily: out.daily, weekly: out.weekly, monthly: out.monthly };
}

/** Validates user input for create (full) / update (partial). Returns normalized fields. */
export function validateTargetInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'body must be a JSON object');
  const out = {};
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) throw new HttpError(400, 'name must be 1-63 chars: lowercase letters, digits, "-" or "_", starting with a letter/digit');
    out.name = input.name;
  }
  if (input.type !== undefined && input.type !== 'postgres') throw new HttpError(400, 'type must be "postgres"');
  if (!partial || input.url !== undefined) {
    if (typeof input.url !== 'string') throw new HttpError(400, 'url is required (postgres://user:password@host:5432/database)');
    try { parsePgUrl(input.url); } catch (e) { throw new HttpError(400, e.message); }
    out.url = input.url.trim();
  }
  if (!partial || input.schedule !== undefined) {
    const sched = input.schedule ?? { type: 'daily', time: '03:00' };
    const err = validateSchedule(sched);
    if (err) throw new HttpError(400, err);
    out.schedule = normalizeSchedule(sched);
  }
  if (!partial || input.retention !== undefined) out.retention = validateRetention(input.retention);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    out.enabled = input.enabled;
  }
  return out;
}

export class ConfigStore {
  constructor({ storage, key, secret, log }) {
    this.storage = storage; this.key = key; this.secret = secret; this.log = log;
    this.targets = [];
    this.loaded = false;
    this.exists = false;
    this.locked = null; // reason string when the config cannot be decrypted with the current key
    this.chain = Promise.resolve();
  }

  async load() {
    const doc = await this.storage.getJson(this.key);
    this.loaded = true;
    if (!doc) { this.exists = false; this.targets = []; this.locked = null; return false; }
    this.exists = true;
    this.targets = Array.isArray(doc.targets) ? doc.targets : [];
    this.locked = null;
    try {
      if (doc.keyCheck) {
        if (decryptString(doc.keyCheck, this.secret) !== CHECK_PLAIN) throw new Error('bad check');
      }
    } catch {
      this.locked = 'BACKUP_CONFIG_KEY does not match the key used to encrypt _vault/config.json. Restore the original key; the stored config was left untouched.';
      this.log.error(this.locked);
    }
    for (const t of this.targets) {
      try { registerUrlSecrets(this.urlOf(t)); } catch { /* locked */ }
    }
    return true;
  }

  get(name) { return this.targets.find((t) => t.name === name); }

  urlOf(t) { return decryptString(t.url, this.secret); }

  /** Public (safe) view of a target. */
  view(t) {
    let url;
    try { url = redactUrl(this.urlOf(t)); } catch { url = '(cannot decrypt — wrong BACKUP_CONFIG_KEY?)'; }
    return {
      name: t.name, type: t.type, url, schedule: t.schedule, retention: t.retention,
      enabled: t.enabled, createdAt: t.createdAt, updatedAt: t.updatedAt,
    };
  }

  assertWritable() {
    if (this.locked) throw new HttpError(409, this.locked);
  }

  /** Serialises mutations; `fn` mutates this.targets, then we persist. */
  mutate(fn) {
    const run = async () => {
      this.assertWritable();
      const before = JSON.stringify(this.targets);
      try {
        const res = fn(this.targets);
        await this.save();
        return res;
      } catch (e) {
        this.targets = JSON.parse(before);
        throw e;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async save() {
    const doc = {
      version: 1,
      updatedAt: new Date().toISOString(),
      keyCheck: encryptString(CHECK_PLAIN, this.secret),
      targets: this.targets,
    };
    await this.storage.putJson(this.key, doc);
    this.exists = true;
  }

  /** Build a stored target from validated input. */
  build(v, now = new Date()) {
    registerUrlSecrets(v.url);
    const iso = now.toISOString();
    return {
      name: v.name, type: 'postgres', url: encryptString(v.url, this.secret),
      schedule: v.schedule, retention: v.retention, enabled: v.enabled ?? true, createdAt: iso, updatedAt: iso,
    };
  }
}
