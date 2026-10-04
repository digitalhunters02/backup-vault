// Environment configuration. Fails fast with a readable list of what is wrong.
export class ConfigError extends Error {}

export const DEFAULT_RETENTION = Object.freeze({ daily: 7, weekly: 4, monthly: 6 });

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function regionFromEndpoint(endpoint) {
  const m = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint || '');
  return m ? m[1] : null;
}

export function loadEnv(src = process.env) {
  const problems = [];
  const need = (name, minLen = 1) => {
    const v = (src[name] ?? '').trim();
    if (v.length < minLen) problems.push(minLen > 1 ? `${name} is required (min ${minLen} characters)` : `${name} is required`);
    return v;
  };
  const apiKey = need('BACKUP_API_KEY', 16);
  const configKey = need('BACKUP_CONFIG_KEY', 16);
  const bucket = need('S3_BUCKET');
  const accessKeyId = need('S3_ACCESS_KEY_ID');
  const secretAccessKey = need('S3_SECRET_ACCESS_KEY');
  const endpoint = (src.S3_ENDPOINT ?? '').trim() || undefined;
  if (endpoint && !/^https?:\/\//i.test(endpoint)) problems.push('S3_ENDPOINT must start with http:// or https://');
  const region = (src.S3_REGION ?? '').trim() || regionFromEndpoint(endpoint) || 'us-east-1';
  const prefix = ((src.S3_PREFIX ?? '').trim() || 'vault').replace(/^\/+|\/+$/g, '');
  const encKey = (src.BACKUP_ENCRYPTION_KEY ?? '').trim() || undefined;
  if (encKey && encKey.length < 16) problems.push('BACKUP_ENCRYPTION_KEY must have at least 16 characters (or be empty to disable)');
  const tz = (src.TZ ?? '').trim() || 'America/Denver';
  if (!isValidTimeZone(tz)) problems.push(`TZ "${tz}" is not a valid IANA time zone`);
  const port = Number(src.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be a number between 1 and 65535');

  let seed;
  if ((src.BACKUP_TARGETS_JSON ?? '').trim()) {
    try {
      seed = JSON.parse(src.BACKUP_TARGETS_JSON);
      if (!Array.isArray(seed)) throw new Error('must be a JSON array');
    } catch (e) { problems.push(`BACKUP_TARGETS_JSON is not valid: ${e.message}`); }
  }

  let forcePathStyle;
  const fps = (src.S3_FORCE_PATH_STYLE ?? '').trim().toLowerCase();
  if (fps) forcePathStyle = ['1', 'true', 'yes'].includes(fps);
  else forcePathStyle = Boolean(endpoint); // custom endpoint (B2/minio) => path style; AWS => virtual host

  if (problems.length) throw new ConfigError('Invalid configuration:\n - ' + problems.join('\n - '));

  return {
    port, tz, apiKey, configKey, encKey, seed,
    s3: { endpoint, region, bucket, accessKeyId, secretAccessKey, prefix, forcePathStyle },
    tmpDir: (src.BACKUP_TMP_DIR ?? '').trim() || undefined,
    dumpTimeoutMs: Math.max(1, Number(src.BACKUP_DUMP_TIMEOUT_MIN || 120)) * 60_000,
    autoSchedule: (src.BACKUP_SCHEDULER ?? 'on').toLowerCase() !== 'off',
    pgDump: (src.PG_DUMP_PATH ?? '').trim() || 'pg_dump',
    pgRestore: (src.PG_RESTORE_PATH ?? '').trim() || 'pg_restore',
  };
}
