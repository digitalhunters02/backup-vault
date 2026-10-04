// GFS retention: keep the newest backup of each of the last D days, W ISO weeks and M months
// (counting only periods that actually contain a backup). The newest backup is ALWAYS kept.
import { localParts, isoWeekKey } from './tz.js';
import { DEFAULT_RETENTION } from './config.js';

/**
 * @param {{key:string,time:number}[]} items   successful backups (time = epoch ms)
 * @param {{daily:number,weekly:number,monthly:number}} policy
 * @param {string} tz  zone used to decide where a "day/week/month" starts
 * @returns {{keep: object[], remove: object[], reasons: Map<string,string[]>}}
 */
export function selectRetention(items, policy = DEFAULT_RETENTION, tz = 'UTC') {
  const p = {
    daily: nonNeg(policy?.daily, DEFAULT_RETENTION.daily),
    weekly: nonNeg(policy?.weekly, DEFAULT_RETENTION.weekly),
    monthly: nonNeg(policy?.monthly, DEFAULT_RETENTION.monthly),
  };
  const sorted = [...items].sort((a, b) => b.time - a.time || (a.key < b.key ? 1 : -1));
  const reasons = new Map();
  const mark = (it, why) => { if (!reasons.has(it.key)) reasons.set(it.key, []); reasons.get(it.key).push(why); };

  if (sorted.length) mark(sorted[0], 'newest');

  const periods = [
    ['daily', (lp) => `${lp.year}-${pad(lp.month)}-${pad(lp.day)}`],
    ['weekly', (lp) => isoWeekKey(lp.year, lp.month, lp.day)],
    ['monthly', (lp) => `${lp.year}-${pad(lp.month)}`],
  ];
  for (const [name, keyFn] of periods) {
    const limit = p[name];
    const seen = new Set();
    for (const it of sorted) {
      const k = keyFn(localParts(it.time, tz));
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      mark(it, name);
    }
  }
  const keep = sorted.filter((i) => reasons.has(i.key));
  const remove = sorted.filter((i) => !reasons.has(i.key));
  return { keep, remove, reasons };
}

function nonNeg(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}
const pad = (n) => String(n).padStart(2, '0');
