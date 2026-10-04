// Secret redaction. Every log line, API error and stored error message goes through here.
const secrets = new Set();

/** Register a value that must never appear in logs/responses (also its URL-encoded forms). */
export function registerSecret(value) {
  if (typeof value !== 'string' || value.length < 4) return;
  secrets.add(value);
  try { secrets.add(encodeURIComponent(value)); } catch { /* ignore */ }
  try { secrets.add(decodeURIComponent(value)); } catch { /* ignore */ }
}

export function clearSecrets() { secrets.clear(); }

/** Register the password (raw and as written) of a postgres connection URL. */
export function registerUrlSecrets(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^:/\s@]*:([^\s/]+)@/i.exec(String(url || ''));
  if (m) registerSecret(m[1]);
  try {
    const u = new URL(url);
    if (u.password) { registerSecret(u.password); registerSecret(decodeURIComponent(u.password)); }
  } catch { /* ignore */ }
}

const URL_CRED = /(:\/\/[^:/\s@]*):([^\s/]+)@/g;
const KV_SECRET = /\b(PGPASSWORD|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;

export function redact(text) {
  if (text === undefined || text === null) return text;
  let s = String(text);
  const list = [...secrets].sort((a, b) => b.length - a.length);
  for (const sec of list) s = s.split(sec).join('***');
  s = s.replace(URL_CRED, '$1:***@');
  s = s.replace(KV_SECRET, '$1$2***');
  return s;
}

/** postgres://user:pass@host:5432/db -> postgres://user:***@host:5432/db */
export function redactUrl(url) {
  const s = String(url ?? '');
  try {
    const u = new URL(s);
    const user = u.username ? decodeURIComponent(u.username) : '';
    const auth = user || u.password ? `${encodeURIComponent(user)}${u.password ? ':***' : ''}@` : '';
    const port = u.port ? `:${u.port}` : '';
    // keep query params but hide anything that looks like a secret
    const q = u.search ? u.search.replace(/((?:password|sslpassword|sslkey)=)[^&]*/gi, '$1***') : '';
    return `${u.protocol}//${auth}${u.hostname}${port}${u.pathname}${q}`;
  } catch {
    return redact(s.replace(URL_CRED, '$1:***@'));
  }
}
