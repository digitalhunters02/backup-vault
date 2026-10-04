// The service brain: config, state cache, run queue (concurrency 1), scheduler tick, retention, status.
import { ConfigStore, HttpError, validateTargetInput } from './configStore.js';
import { makeKeys, NAME_RE, msToTs } from './keys.js';
import { executeBackup } from './runner.js';
import { selectRetention } from './retention.js';
import { isDue, nextRunAt, intervalMs } from './schedule.js';
import { targetHealth, overallHealth, staleAfterMs } from './health.js';
import { testConnection } from './pg.js';
import { redact, registerUrlSecrets } from './redact.js';

const DAY = 86_400_000;
const USAGE_TTL = 10 * 60_000;

export class Vault {
  constructor({ env, storage, log, now = () => Date.now(), runner = executeBackup }) {
    this.env = env; this.storage = storage; this.log = log; this.now = now; this.runner = runner;
    this.keys = makeKeys(env.s3.prefix);
    this.store = new ConfigStore({ storage, key: this.keys.config, secret: env.configKey, log });
    this.state = new Map();        // target -> { lastRun, lastSuccessMs, lastTs }
    this.queue = [];
    this.current = null;
    this.ready = false;
    this.initPromise = null;
    this.initError = null;
    this.usageCache = null;
    this.timer = null;
    this.ticking = false;
  }

  // ---------- lifecycle ----------
  async ensureReady() {
    if (this.ready) return;
    if (!this.initPromise) {
      this.initPromise = this.#init()
        .then(() => { this.ready = true; this.initError = null; })
        .catch((e) => { this.initError = redact(e.message || String(e)); throw new HttpError(503, `storage not ready: ${this.initError}`); })
        .finally(() => { this.initPromise = null; });
    }
    return this.initPromise;
  }

  async #init() {
    const found = await this.store.load();
    if (!found && this.env.seed?.length) {
      this.log.info(`no config in bucket yet: seeding ${this.env.seed.length} target(s) from BACKUP_TARGETS_JSON`);
      const built = [];
      for (const raw of this.env.seed) {
        const v = validateTargetInput(raw);
        built.push(this.store.build(v));
      }
      this.store.targets = built;
      await this.store.save();
    }
    for (const t of this.store.targets) await this.#loadState(t.name);
    this.log.info(`ready: ${this.store.targets.length} target(s), bucket "${this.env.s3.bucket}", prefix "${this.env.s3.prefix}"`);
  }

  startScheduler() {
    if (this.timer) return;
    const loop = async () => {
      try { await this.tick(); } catch (e) { this.log.error(`scheduler tick failed: ${e.message}`); }
      this.timer = setTimeout(loop, 60_000 - (Date.now() % 60_000) + 50);
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, 3000);
    this.timer.unref?.();
  }

  stopScheduler() { clearTimeout(this.timer); this.timer = null; }

  // ---------- state cache (last run / last success per target, rebuilt from run records) ----------
  async #loadState(name) {
    const recKeys = (await this.storage.list(this.keys.runsPrefix(name))).map((o) => o.key).filter((k) => k.endsWith('.json')).sort();
    let lastRun = null, lastSuccess = null;
    for (let i = recKeys.length - 1, n = 0; i >= 0 && n < 30; i--, n++) {
      let rec;
      try { rec = await this.storage.getJson(recKeys[i]); } catch { rec = null; }
      if (!rec) continue;
      if (!lastRun) lastRun = rec;
      if (rec.status === 'success') { lastSuccess = rec; break; }
    }
    this.#setState(name, lastRun, lastSuccess);
  }

  #setState(name, lastRun, lastSuccess) {
    const prev = this.state.get(name) || {};
    this.state.set(name, {
      lastRun, lastSuccess,
      lastSuccessMs: lastSuccess ? Date.parse(lastSuccess.startedAt) : null,
      lastTs: prev.lastTs ?? null,
    });
  }

  #applyRecord(name, rec) {
    const st = this.state.get(name) || {};
    this.#setState(name, rec, rec.status === 'success' ? rec : st.lastSuccess ?? null);
    this.state.get(name).lastTs = rec._ts ?? null;
  }

  // ---------- targets ----------
  requireTarget(name) {
    const t = NAME_RE.test(name || '') ? this.store.get(name) : null;
    if (!t) throw new HttpError(404, `target "${name}" not found`);
    return t;
  }

  async listTargets() {
    await this.ensureReady();
    return this.store.targets.map((t) => this.store.view(t));
  }

  async getTarget(name) {
    await this.ensureReady();
    return this.store.view(this.requireTarget(name));
  }

  async createTarget(input) {
    await this.ensureReady();
    const v = validateTargetInput(input);
    const t = await this.store.mutate((targets) => {
      if (targets.some((x) => x.name === v.name)) throw new HttpError(409, `target "${v.name}" already exists`);
      const built = this.store.build(v);
      targets.push(built);
      return built;
    });
    await this.#loadState(t.name); // picks up history if the target is re-created
    this.log.info(`target created: ${t.name}`);
    return this.store.view(t);
  }

  async updateTarget(name, input) {
    await this.ensureReady();
    this.requireTarget(name);
    if (input && input.name !== undefined && input.name !== name) throw new HttpError(400, 'name cannot be changed (create a new target instead)');
    const v = validateTargetInput({ ...input, name: undefined }, { partial: true });
    const t = await this.store.mutate((targets) => {
      const cur = targets.find((x) => x.name === name);
      if (v.url !== undefined) { registerUrlSecrets(v.url); cur.url = this.store.build({ ...v, name, schedule: cur.schedule, retention: cur.retention }).url; }
      if (v.schedule) cur.schedule = v.schedule;
      if (v.retention) cur.retention = v.retention;
      if (v.enabled !== undefined) cur.enabled = v.enabled;
      cur.updatedAt = new Date().toISOString();
      return cur;
    });
    this.log.info(`target updated: ${name}`);
    return this.store.view(t);
  }

  async deleteTarget(name, { deleteBackups = false } = {}) {
    await this.ensureReady();
    this.requireTarget(name);
    if (this.current?.name === name) throw new HttpError(409, 'a backup of this target is running right now; try again in a moment');
    await this.store.mutate((targets) => { targets.splice(targets.findIndex((x) => x.name === name), 1); });
    for (const j of this.queue.filter((x) => x.name === name)) j.reject(new HttpError(409, 'target was removed'));
    this.queue = this.queue.filter((j) => j.name !== name);
    this.state.delete(name);
    let deleted = 0;
    if (deleteBackups) {
      for (const o of await this.storage.list(this.keys.targetPrefix(name))) { await this.storage.delete(o.key); deleted++; }
      for (const o of await this.storage.list(this.keys.runsPrefix(name))) { await this.storage.delete(o.key); deleted++; }
      this.usageCache = null;
    }
    this.log.info(`target deleted: ${name} (backups ${deleteBackups ? `deleted: ${deleted} objects` : 'kept in the bucket'})`);
    return { ok: true, deletedObjects: deleted, backupsKept: !deleteBackups };
  }

  async testTarget(name) {
    await this.ensureReady();
    const t = this.requireTarget(name);
    let url;
    try { url = this.store.urlOf(t); } catch { throw new HttpError(409, 'cannot decrypt the stored URL (wrong BACKUP_CONFIG_KEY?)'); }
    registerUrlSecrets(url);
    return testConnection(url, { pgDumpBin: this.env.pgDump });
  }

  // ---------- running ----------
  /** Queue a backup. Resolves with the run record when it finishes. Rejects (409) if the target is already queued/running. */
  enqueue(name, trigger = 'manual') {
    this.requireTarget(name);
    if (this.current?.name === name || this.queue.some((j) => j.name === name)) {
      throw new HttpError(409, `a backup of "${name}" is already running or queued`);
    }
    const job = { name, trigger, queuedAt: this.now() };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.promise.catch(() => {});
    this.queue.push(job);
    setImmediate(() => this.#pump());
    return job;
  }

  #pump() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = { name: job.name, trigger: job.trigger, startedAt: new Date().toISOString() };
    this.#runJob(job)
      .then((rec) => job.resolve(rec), (e) => job.reject(e))
      .finally(() => { this.current = null; setImmediate(() => this.#pump()); });
  }

  async #runJob(job) {
    let url;
    const t = this.store.get(job.name);
    const recFail = (msg) => ({ target: job.name, status: 'failed', error: msg });
    if (!t) return recFail('target was removed before the run started');
    try {
      if (this.store.locked) throw new Error(this.store.locked);
      url = this.store.urlOf(t);
    } catch (e) {
      // record the failure so it shows up in the history and in /status
      const started = this.now();
      const rec = {
        target: job.name, trigger: job.trigger, status: 'failed', startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(), durationMs: 0, sizeBytes: null, sha256: null, key: null,
        encrypted: Boolean(this.env.encKey), verified: false, error: redact(`config: ${e.message}`),
      };
      try { await this.storage.putJson(this.keys.runKey(job.name, msToTs(started)), rec); } catch { /* ignore */ }
      this.#applyRecord(job.name, rec);
      return rec;
    }
    const st = this.state.get(job.name);
    const rec = await this.runner({
      target: job.name, url, storage: this.storage, keys: this.keys, env: this.env, log: this.log,
      trigger: job.trigger, now: this.now(), lastTs: st?.lastTs ?? null,
    });
    this.#applyRecord(job.name, rec);
    this.usageCache = null;
    if (rec.status === 'success') {
      try {
        const r = await this.prune(job.name);
        if (r.removed) this.log.info(`[${job.name}] retention: removed ${r.removed} old backup(s), kept ${r.kept}`);
      } catch (e) {
        this.log.error(`[${job.name}] retention pruning failed: ${e.message}`);
      }
    }
    return rec;
  }

  /** Called every minute (and directly in tests with a fake clock). */
  async tick(nowMs = this.now()) {
    if (this.ticking) return [];
    this.ticking = true;
    const queued = [];
    try {
      await this.ensureReady();
      if (this.store.locked) return queued;
      for (const t of this.store.targets) {
        if (!t.enabled) continue;
        if (this.current?.name === t.name || this.queue.some((j) => j.name === t.name)) continue; // never double-run
        const st = this.state.get(t.name) || {};
        const lastFailureMs = st.lastRun && st.lastRun.status === 'failed' && (st.lastSuccessMs == null || Date.parse(st.lastRun.startedAt) > st.lastSuccessMs)
          ? Date.parse(st.lastRun.finishedAt || st.lastRun.startedAt) : null;
        if (isDue({ schedule: t.schedule, tz: this.env.tz, now: nowMs, lastSuccessMs: st.lastSuccessMs ?? null, lastFailureMs })) {
          this.log.info(`[${t.name}] due: queueing scheduled backup`);
          queued.push({ name: t.name, job: this.enqueue(t.name, 'schedule') });
        }
      }
    } finally {
      this.ticking = false;
    }
    return queued;
  }

  // ---------- retention ----------
  async listBackups(name) {
    const objs = await this.storage.list(this.keys.targetPrefix(name));
    const out = [];
    for (const o of objs) {
      const p = this.keys.parseDumpKey(o.key);
      if (p && p.target === name) out.push({ key: o.key, size: o.size, time: p.time, ts: p.ts, encrypted: p.encrypted, lastModified: o.lastModified });
    }
    return out.sort((a, b) => b.time - a.time);
  }

  async prune(name) {
    const t = this.store.get(name);
    if (!t) return { removed: 0, kept: 0 };
    const backups = await this.listBackups(name);
    const { keep, remove } = selectRetention(backups.map((b) => ({ key: b.key, time: b.time })), t.retention, this.env.tz);
    for (const r of remove) {
      await this.storage.delete(r.key);
      const ts = this.keys.parseDumpKey(r.key).ts;
      await this.storage.delete(this.keys.runKey(name, ts)).catch(() => {});
    }
    // old run records with no backup behind them (failed runs): keep 30 days
    const live = new Set(keep.map((k) => this.keys.parseDumpKey(k.key).ts));
    const recs = (await this.storage.list(this.keys.runsPrefix(name))).filter((o) => o.key.endsWith('.json'));
    const cutoff = this.now() - 30 * DAY;
    for (const o of recs) {
      const ts = o.key.slice(this.keys.runsPrefix(name).length, -5);
      if (live.has(ts)) continue;
      const when = o.lastModified || 0;
      if (when && when < cutoff) await this.storage.delete(o.key).catch(() => {});
    }
    if (remove.length) this.usageCache = null;
    return { removed: remove.length, kept: keep.length };
  }

  // ---------- reads for the API ----------
  async listRuns(name, limit = 20) {
    await this.ensureReady();
    this.requireTarget(name);
    const keys = (await this.storage.list(this.keys.runsPrefix(name))).map((o) => o.key).filter((k) => k.endsWith('.json')).sort().reverse().slice(0, limit);
    const recs = await Promise.all(keys.map((k) => this.storage.getJson(k).catch(() => null)));
    return recs.filter(Boolean);
  }

  async backups(name) {
    await this.ensureReady();
    this.requireTarget(name);
    const list = await this.listBackups(name);
    return list.map((b, i) => ({
      key: b.key, sizeBytes: b.size, createdAt: new Date(b.time).toISOString(), encrypted: b.encrypted, newest: i === 0,
    }));
  }

  async downloadUrl(key) {
    await this.ensureReady();
    const p = this.keys.parseDumpKey(key);
    if (!p) throw new HttpError(400, 'key is not a backup file of this vault');
    if (!(await this.storage.head(key))) throw new HttpError(404, 'backup not found');
    const filename = key.split('/').pop();
    const url = await this.storage.presignGet(key, { expiresIn: 600, filename });
    return { url, expiresInSeconds: 600, filename, encrypted: p.encrypted };
  }

  async deleteBackup(key) {
    await this.ensureReady();
    const p = this.keys.parseDumpKey(key);
    if (!p) throw new HttpError(400, 'key is not a backup file of this vault');
    if (!(await this.storage.head(key))) throw new HttpError(404, 'backup not found');
    const all = await this.listBackups(p.target);
    if (all[0]?.key === key) throw new HttpError(409, 'refusing to delete the most recent backup of this target');
    await this.storage.delete(key);
    await this.storage.delete(this.keys.runKey(p.target, p.ts)).catch(() => {});
    this.usageCache = null;
    this.log.info(`backup deleted manually: ${key}`);
    return { ok: true, deleted: key };
  }

  async usage(force = false) {
    if (!force && this.usageCache && Date.now() - this.usageCache.at < USAGE_TTL) return this.usageCache;
    const objs = await this.storage.list(this.keys.all);
    const byTarget = new Map();
    let total = 0;
    for (const o of objs) {
      total += o.size;
      const p = this.keys.parseDumpKey(o.key);
      if (p) {
        const e = byTarget.get(p.target) || { bytes: 0, count: 0 };
        e.bytes += o.size; e.count++;
        byTarget.set(p.target, e);
      }
    }
    this.usageCache = { at: Date.now(), total, byTarget };
    return this.usageCache;
  }

  async bucketTest() {
    return this.storage.selfTest(this.env.s3.prefix);
  }

  async status({ refresh = false } = {}) {
    const now = this.now();
    const base = {
      checkedAt: new Date(now).toISOString(), timezone: this.env.tz, encryption: Boolean(this.env.encKey),
      running: this.current ? { ...this.current } : null, queued: this.queue.map((j) => j.name),
    };
    try { await this.ensureReady(); } catch (e) {
      return { ...base, status: 'failing', ready: false, error: e.message, targets: [], totalStoredBytes: null };
    }
    if (refresh) await Promise.all(this.store.targets.map((t) => this.#loadState(t.name)));
    let usage = null, usageError = null;
    try { usage = await this.usage(refresh); } catch (e) { usageError = redact(e.message); }
    const targets = this.store.targets.map((t) => {
      const st = this.state.get(t.name) || {};
      const health = targetHealth({ target: t, lastRun: st.lastRun, lastSuccessMs: st.lastSuccessMs ?? null, now });
      const failedAfter = st.lastRun?.status === 'failed' && (st.lastSuccessMs == null || Date.parse(st.lastRun.startedAt) > st.lastSuccessMs);
      const u = usage?.byTarget.get(t.name);
      return {
        name: t.name, enabled: t.enabled, status: health, schedule: t.schedule,
        lastSuccess: st.lastSuccess ? { at: st.lastSuccess.startedAt, finishedAt: st.lastSuccess.finishedAt, key: st.lastSuccess.key, sizeBytes: st.lastSuccess.sizeBytes, durationMs: st.lastSuccess.durationMs, verified: st.lastSuccess.verified } : null,
        lastRun: st.lastRun ? { status: st.lastRun.status, startedAt: st.lastRun.startedAt, finishedAt: st.lastRun.finishedAt, durationMs: st.lastRun.durationMs, trigger: st.lastRun.trigger, error: st.lastRun.error ?? null } : null,
        nextRunAt: t.enabled && !this.store.locked
          ? new Date(nextRunAt({ schedule: t.schedule, tz: this.env.tz, now, lastSuccessMs: st.lastSuccessMs ?? null, lastFailureMs: failedAfter ? Date.parse(st.lastRun.finishedAt || st.lastRun.startedAt) : null })).toISOString()
          : null,
        staleAfterHours: Math.round(staleAfterMs(t.schedule) / 360000) / 10,
        intervalHours: intervalMs(t.schedule) / 3_600_000,
        storedBytes: u?.bytes ?? 0, backupCount: u?.count ?? 0,
        running: this.current?.name === t.name, queued: this.queue.some((j) => j.name === t.name),
      };
    });
    return {
      ...base, ready: true,
      status: overallHealth(targets.map((x) => x.status)),
      configLocked: this.store.locked,
      totalStoredBytes: usage?.total ?? null, usageError,
      usageAt: usage ? new Date(usage.at).toISOString() : null,
      targetCount: targets.length, targets,
    };
  }
}
