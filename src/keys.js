// Object key layout inside the bucket (everything under S3_PREFIX):
//   <prefix>/_vault/config.json
//   <prefix>/_vault/runs/<target>/<timestamp>.json
//   <prefix>/<target>/<YYYY>/<MM>/<target>-<timestamp>.dump[.enc]
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const join = (...p) => p.filter((x) => x !== '' && x != null).join('/');

export function makeKeys(prefix) {
  return {
    config: join(prefix, '_vault', 'config.json'),
    runsPrefix: (target) => join(prefix, '_vault', 'runs', target) + '/',
    runKey: (target, ts) => join(prefix, '_vault', 'runs', target, `${ts}.json`),
    targetPrefix: (target) => join(prefix, target) + '/',
    dumpKey: (target, ts, year, month, encrypted) =>
      join(prefix, target, year, month, `${target}-${ts}.dump${encrypted ? '.enc' : ''}`),
    all: join(prefix) + '/',
    /** Validate + parse a dump key coming from an API client. Returns null if it is not a dump of ours. */
    parseDumpKey(key) {
      if (typeof key !== 'string' || key.includes('..') || key.includes('//') || key.includes('\0')) return null;
      const base = prefix ? prefix + '/' : '';
      if (!key.startsWith(base)) return null;
      const rest = key.slice(base.length).split('/');
      if (rest.length !== 4) return null;
      const [target, year, month, file] = rest;
      if (!NAME_RE.test(target) || !/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) return null;
      const m = /^(.+)-(\d{8}T\d{6}Z)\.dump(\.enc)?$/.exec(file);
      if (!m || m[1] !== target) return null;
      return { target, ts: m[2], encrypted: Boolean(m[3]), time: tsToMs(m[2]) };
    },
  };
}

/** epoch ms -> 20261004T031500Z (UTC, second precision) */
export function msToTs(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function tsToMs(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(ts);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}
