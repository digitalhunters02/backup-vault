import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRetention } from '../src/retention.js';
import { zonedToUtc, isoWeekKey } from '../src/tz.js';

const TZ = 'America/Denver';
const at = (y, m, d, hh = 3, mm = 0) => zonedToUtc(y, m, d, hh, mm, TZ);
const mk = (list) => list.map((t, i) => ({ key: `k${i}-${new Date(t).toISOString()}`, time: t }));
const keysOf = (r) => r.keep.map((x) => x.time);

test('empty and single item', () => {
  assert.deepEqual(selectRetention([], undefined, TZ), { keep: [], remove: [], reasons: new Map() });
  const one = mk([at(2026, 1, 1)]);
  const r = selectRetention(one, { daily: 1, weekly: 0, monthly: 0 }, TZ);
  assert.equal(r.keep.length, 1);
  assert.equal(r.remove.length, 0);
});

test('keeps D daily backups, one per day, newest per day', () => {
  // 3 backups per day for 10 days
  const items = [];
  for (let d = 1; d <= 10; d++) for (const h of [3, 12, 20]) items.push(at(2026, 3, d, h));
  const r = selectRetention(mk(items), { daily: 7, weekly: 0, monthly: 0 }, TZ);
  assert.equal(r.keep.length, 7);
  assert.deepEqual(keysOf(r), [10, 9, 8, 7, 6, 5, 4].map((d) => at(2026, 3, d, 20)));
});

test('classic 7/4/6 over a year of daily backups', () => {
  const items = [];
  const start = Date.UTC(2025, 5, 1, 10);
  for (let i = 0; i < 400; i++) items.push(start + i * 86_400_000);
  const r = selectRetention(mk(items), { daily: 7, weekly: 4, monthly: 6 }, 'UTC');
  // 7 dailies + weeks 2-4 (week 1 overlaps) + months (overlaps with current month)
  assert.ok(r.keep.length >= 7 + 3 && r.keep.length <= 7 + 4 + 6, `kept ${r.keep.length}`);
  assert.equal(r.keep.length + r.remove.length, 400);
  const newest = Math.max(...items);
  assert.ok(keysOf(r).includes(newest));
  // the 7 newest days are all kept
  for (let i = 0; i < 7; i++) assert.ok(keysOf(r).includes(newest - i * 86_400_000));
  // at least 6 distinct months and 4 distinct weeks represented
  const months = new Set(r.keep.map((k) => new Date(k.time).toISOString().slice(0, 7)));
  assert.ok(months.size >= 6, `months ${months.size}`);
  // nothing older than ~7 months survives
  const oldest = Math.min(...keysOf(r));
  assert.ok(newest - oldest < 220 * 86_400_000, 'too old kept');
});

test('weekly keeps one per ISO week even when dailies are exhausted', () => {
  const items = [];
  for (let d = 0; d < 60; d++) items.push(Date.UTC(2026, 0, 1, 12) + d * 86_400_000);
  const r = selectRetention(mk(items), { daily: 1, weekly: 4, monthly: 0 }, 'UTC');
  const weeks = new Set(r.keep.map((k) => { const d = new Date(k.time); return isoWeekKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }));
  assert.equal(weeks.size, 4);
  assert.equal(r.keep.length, 4); // newest of the current week doubles as the daily one
});

test('monthly keeps newest per month', () => {
  const items = [at(2026, 1, 5), at(2026, 1, 28), at(2026, 2, 3), at(2026, 2, 27), at(2026, 3, 1), at(2026, 3, 30)];
  const r = selectRetention(mk(items), { daily: 1, weekly: 0, monthly: 3 }, TZ);
  assert.deepEqual(new Set(keysOf(r)), new Set([at(2026, 3, 30), at(2026, 2, 27), at(2026, 1, 28)]));
});

test('NEVER deletes the newest backup, even with zero policy values', () => {
  const items = [at(2026, 1, 1), at(2026, 1, 2), at(2026, 1, 3)];
  for (const p of [{ daily: 0, weekly: 0, monthly: 0 }, { daily: -5, weekly: NaN, monthly: 'x' }]) {
    const r = selectRetention(mk(items), p, TZ);
    assert.ok(keysOf(r).includes(at(2026, 1, 3)));
    assert.ok(r.reasons.get(r.keep[0].key).includes('newest') || r.keep.length >= 1);
  }
  const r0 = selectRetention(mk(items), { daily: 0, weekly: 0, monthly: 0 }, TZ);
  assert.equal(r0.keep.length, 1);
  assert.equal(r0.remove.length, 2);
});

test('input order does not matter and input is not mutated', () => {
  const items = mk([at(2026, 1, 3), at(2026, 1, 1), at(2026, 1, 2)]);
  const copy = JSON.stringify(items);
  const r = selectRetention(items, { daily: 2, weekly: 0, monthly: 0 }, TZ);
  assert.equal(JSON.stringify(items), copy);
  assert.deepEqual(keysOf(r), [at(2026, 1, 3), at(2026, 1, 2)]);
});

test('the timezone decides where a day starts', () => {
  // 23:30 and 00:30 UTC on consecutive dates are the same calendar day in Denver (UTC-7)
  const a = Date.UTC(2026, 0, 10, 23, 30), b = Date.UTC(2026, 0, 11, 0, 30);
  const utc = selectRetention(mk([a, b]), { daily: 5, weekly: 0, monthly: 0 }, 'UTC');
  assert.equal(utc.keep.length, 2);
  const den = selectRetention(mk([a, b]), { daily: 5, weekly: 0, monthly: 0 }, TZ);
  assert.equal(den.keep.length, 1);
  assert.deepEqual(keysOf(den), [b]);
});

test('defaults are 7/4/6 when policy is missing', () => {
  const items = [];
  for (let d = 0; d < 30; d++) items.push(Date.UTC(2026, 5, 1, 5) + d * 86_400_000);
  const a = selectRetention(mk(items), undefined, 'UTC');
  const b = selectRetention(mk(items), { daily: 7, weekly: 4, monthly: 6 }, 'UTC');
  assert.deepEqual(a.keep.map((x) => x.key), b.keep.map((x) => x.key));
});

test('many backups per day are collapsed, sparse history is fully kept', () => {
  const sparse = mk([at(2026, 1, 1), at(2026, 2, 1), at(2026, 3, 1)]);
  assert.equal(selectRetention(sparse, { daily: 7, weekly: 4, monthly: 6 }, TZ).remove.length, 0);
  const dense = mk(Array.from({ length: 48 }, (_, i) => Date.UTC(2026, 0, 1) + i * 3_600_000)); // hourly for 2 days (UTC)
  const r = selectRetention(dense, { daily: 2, weekly: 0, monthly: 0 }, 'UTC');
  assert.equal(r.keep.length, 2);
});
