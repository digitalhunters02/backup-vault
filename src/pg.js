// PostgreSQL helpers: URL parsing, environment for pg_dump (so the password never appears in argv), quick connect test.
import { spawn } from 'node:child_process';
import pg from 'pg';
import { redact } from './redact.js';

export function parsePgUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('connection URL is not valid (expected postgres://user:password@host:5432/database)'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('connection URL must start with postgres:// or postgresql://');
  if (!u.hostname) throw new Error('connection URL has no host');
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined;
  if (!database) throw new Error('connection URL has no database name (…/database)');
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database,
    sslmode: u.searchParams.get('sslmode') || undefined,
  };
}

/** Minimal env for libpq tools: no S3 credentials, no API keys leak into child processes. */
export function pgChildEnv(url) {
  const c = parsePgUrl(url);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C.UTF-8',
    PGHOST: c.host, PGPORT: String(c.port), PGDATABASE: c.database, PGCONNECT_TIMEOUT: '15',
  };
  if (c.user) env.PGUSER = c.user;
  if (c.password) env.PGPASSWORD = c.password;
  if (c.sslmode) env.PGSSLMODE = c.sslmode;
  return env;
}

function sslFor(mode) {
  if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') return false;
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };
  return true; // verify-ca / verify-full
}

/** Runs a child process, collects stdout/stderr (capped), supports timeout. Never throws on non-zero exit. */
export function runProcess(cmd, args, { env, timeoutMs = 60_000, maxOut = 1_000_000, stdoutToFile } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, settled = false;
    const child = spawn(cmd, args, { env, stdio: ['ignore', stdoutToFile ? 'ignore' : 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout?.on('data', (d) => { if (out.length < maxOut) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 64_000) err += d; });
    const done = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut, spawnError });
    };
    child.on('error', (e) => done(null, e));
    child.on('close', (code) => done(code));
  });
}

export async function binaryVersion(bin) {
  const r = await runProcess(bin, ['--version'], { env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
  if (r.spawnError || r.code !== 0) return null;
  const m = /(\d+)(?:\.(\d+))?/.exec(r.stdout);
  return m ? { text: r.stdout.trim(), major: Number(m[1]) } : { text: r.stdout.trim(), major: null };
}

/** Quick connection test with `pg` + `pg_dump --schema-only` (to /dev/null). */
export async function testConnection(url, { pgDumpBin = 'pg_dump', timeoutMs = 30_000 } = {}) {
  const t0 = Date.now();
  const result = { ok: false, connect: false, schemaDump: false };
  let c;
  try { c = parsePgUrl(url); } catch (e) { return { ...result, error: e.message }; }
  const client = new pg.Client({
    host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
    ssl: sslFor(c.sslmode), connectionTimeoutMillis: 8000, statement_timeout: 8000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const r = await client.query("select version() as v, current_setting('server_version_num')::int as num, pg_database_size(current_database())::bigint as size, (select count(*) from pg_stat_user_tables)::int as tables");
    const row = r.rows[0];
    result.connect = true;
    result.serverVersion = row.v.split(' ').slice(0, 2).join(' ');
    result.serverMajor = Math.floor(row.num / 10000);
    result.databaseSizeBytes = Number(row.size);
    result.tables = row.tables;
  } catch (e) {
    result.error = `connection failed: ${redact(e.message)}`;
    return { ...result, durationMs: Date.now() - t0 };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
  const ver = await binaryVersion(pgDumpBin);
  result.pgDumpVersion = ver?.text ?? null;
  if (!ver) { result.error = 'pg_dump is not installed in this container'; return { ...result, durationMs: Date.now() - t0 }; }
  result.compatible = ver.major != null ? ver.major >= result.serverMajor : null;
  const d = await runProcess(pgDumpBin, ['--schema-only', '--no-password', '-f', '/dev/null'], { env: pgChildEnv(url), timeoutMs });
  result.schemaDump = d.code === 0;
  if (!result.schemaDump) {
    result.error = redact((d.timedOut ? 'pg_dump timed out' : d.spawnError?.message || d.stderr.trim().split('\n').slice(0, 3).join(' ')) || 'pg_dump failed');
    if (result.compatible === false) result.error += ` (pg_dump ${ver.major} is older than the server ${result.serverMajor}: install a newer postgresql-client in the Dockerfile)`;
  }
  result.ok = result.connect && result.schemaDump;
  result.durationMs = Date.now() - t0;
  return result;
}
