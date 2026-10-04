import test from 'node:test';
import assert from 'node:assert/strict';
import { isDue, nextRunAt, latestDailySlot, validateSchedule, FAILURE_RETRY_MS, HOUR } from '../src/schedule.js';
import { targetHealth, overallHealth, staleAfterMs } from '../src/health.js';
import { zonedToUtc, localParts } from '../src/tz.js';

const TZ = 'America/Denver';
const at = (y, m, d, hh, mm = 0) => zonedToUtc(y, m, d, hh, mm, TZ);
const daily = { type: 'daily', time: '03:00' };

test('zonedToUtc handles standard time, daylight time and DST edges', () => {
  assert.equal(new Date(at(2026, 1, 15, 3)).toISOString(), '2026-01-15T10:00:00.000Z'); // MST = UTC-7
  assert.equal(new Date(at(2026, 7, 15, 3)).toISOString(), '2026-07-15T09:00:00.000Z'); // MDT = UTC-6
  // round trip
  const p = localParts(at(2026, 3, 8, 12), TZ);
  assert.deepEqual([p.year, p.month, p.day, p.hour], [2026, 3, 8, 12]);
  // 2026-03-08 is the spring-forward day in Denver; 03:00 exists (after the gap)
  assert.equal(new Date(at(2026, 3, 8, 3)).toISOString(), '2026-03-08T09:00:00.000Z');
  assert.equal(new Date(at(2026, 11, 1, 3)).toISOString(), '2026-11-01T10:00:00.000Z');
});

test('validateSchedule', () => {
  assert.equal(validateSchedule(daily), null);
  assert.equal(validateSchedule({ type: 'interval', everyHours: 6 }), null);
  for (const bad of [null, {}, { type: 'daily' }, { type: 'daily', time: '25:00' }, { type: 'daily', time: '3:00' }, { type: 'interval', everyHours: 0 }, { type: 'interval', everyHours: 1.5 }, { type: 'weekly' }]) {
    assert.ok(validateSchedule(bad), JSON.stringify(bad));
  }
});

test('daily: never ran => due immediately', () => {
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 5, 10, 14), lastSuccessMs: null }), true);
});

test('daily: due only after the slot, once per slot (no double run)', () => {
  const lastOk = at(2026, 5, 10, 3, 0) + 20_000; // finished slightly after 03:00 yesterday
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 5, 10, 14), lastSuccessMs: lastOk }), false);
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 5, 11, 2, 59), lastSuccessMs: lastOk }), false);
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 5, 11, 3, 0), lastSuccessMs: lastOk }), true);
  const ran = at(2026, 5, 11, 3, 0) + 5000;
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 5, 11, 3, 1), lastSuccessMs: ran }), false);
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 5, 11, 23, 59), lastSuccessMs: ran }), false);
});

test('daily: catch-up after downtime (service was down at the slot)', () => {
  const lastOk = at(2026, 5, 10, 3, 0, 0) + 10_000;
  // down all of May 11th 03:00, comes back at 15:30 -> runs immediately
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 5, 11, 15, 30), lastSuccessMs: lastOk }), true);
  // down for 5 days: still just one run due (one slot), after which it is satisfied
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 5, 15, 9), lastSuccessMs: lastOk }), true);
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 5, 15, 9, 1), lastSuccessMs: at(2026, 5, 15, 9) }), false);
});

test('daily: timezone matters (03:00 Denver is 09:00 UTC in summer)', () => {
  const lastOk = Date.UTC(2026, 6, 9, 9, 0, 30);
  assert.equal(isDue({ schedule: daily, tz: TZ, now: Date.UTC(2026, 6, 10, 8, 59), lastSuccessMs: lastOk }), false);
  assert.equal(isDue({ schedule: daily, tz: TZ, now: Date.UTC(2026, 6, 10, 9, 0), lastSuccessMs: lastOk }), true);
  // the same instants in UTC: slot is 03:00 UTC
  assert.equal(isDue({ schedule: daily, tz: 'UTC', now: Date.UTC(2026, 6, 10, 2, 59), lastSuccessMs: Date.UTC(2026, 6, 9, 3, 0, 30) }), false);
  assert.equal(isDue({ schedule: daily, tz: 'UTC', now: Date.UTC(2026, 6, 10, 3, 0), lastSuccessMs: Date.UTC(2026, 6, 9, 3, 0, 30) }), true);
  // Sao Paulo (UTC-3, no DST)
  assert.equal(new Date(latestDailySlot('03:00', 'America/Sao_Paulo', Date.UTC(2026, 6, 10, 12))).toISOString(), '2026-07-10T06:00:00.000Z');
});

test('daily: across DST change the slot stays at 03:00 local', () => {
  const before = at(2026, 3, 7, 3, 0) + 1000;
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 3, 8, 2, 59), lastSuccessMs: before }), false);
  assert.equal(isDue({ schedule: daily, tz: TZ, now: at(2026, 3, 8, 3, 0), lastSuccessMs: before }), true);
});

test('interval: due N hours after the last success, not before', () => {
  const s = { type: 'interval', everyHours: 6 };
  const last = Date.UTC(2026, 0, 1, 0, 0);
  assert.equal(isDue({ schedule: s, tz: TZ, now: last + 6 * HOUR - 1, lastSuccessMs: last }), false);
  assert.equal(isDue({ schedule: s, tz: TZ, now: last + 6 * HOUR, lastSuccessMs: last }), true);
  assert.equal(isDue({ schedule: s, tz: TZ, now: last + 50 * HOUR, lastSuccessMs: last }), true); // catch-up = single run
  assert.equal(isDue({ schedule: s, tz: TZ, now: last, lastSuccessMs: null }), true);
});

test('after a failed run it waits before retrying (back-off), then retries', () => {
  const failedAt = at(2026, 5, 11, 3, 0, 0) + 2000;
  const lastOk = at(2026, 5, 10, 3, 0) + 1000;
  assert.equal(isDue({ schedule: daily, tz: TZ, now: failedAt + 60_000, lastSuccessMs: lastOk, lastFailureMs: failedAt }), false);
  assert.equal(isDue({ schedule: daily, tz: TZ, now: failedAt + FAILURE_RETRY_MS, lastSuccessMs: lastOk, lastFailureMs: failedAt }), true);
});

test('nextRunAt', () => {
  const lastOk = at(2026, 5, 10, 3, 0) + 1000;
  const now = at(2026, 5, 10, 14);
  assert.equal(nextRunAt({ schedule: daily, tz: TZ, now, lastSuccessMs: lastOk }), at(2026, 5, 11, 3));
  assert.equal(nextRunAt({ schedule: daily, tz: TZ, now, lastSuccessMs: null }), now);
  const s = { type: 'interval', everyHours: 4 };
  assert.equal(nextRunAt({ schedule: s, tz: TZ, now, lastSuccessMs: now - HOUR }), now + 3 * HOUR);
  assert.equal(nextRunAt({ schedule: s, tz: TZ, now, lastSuccessMs: now - 9 * HOUR }), now);
  assert.equal(nextRunAt({ schedule: s, tz: TZ, now, lastSuccessMs: now - 9 * HOUR, lastFailureMs: now - 60_000 }), now - 60_000 + FAILURE_RETRY_MS);
});

// ---------- stale / failing ----------
const t = (over = {}) => ({ name: 'x', enabled: true, schedule: daily, createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...over });
const NOW = Date.UTC(2026, 5, 10, 12);

test('stale threshold = 2x interval + 1h grace', () => {
  assert.equal(staleAfterMs(daily), 49 * HOUR);
  assert.equal(staleAfterMs({ type: 'interval', everyHours: 6 }), 13 * HOUR);
});

test('targetHealth: healthy / stale boundary', () => {
  const ok = (ageH) => targetHealth({ target: t(), lastRun: { status: 'success', startedAt: new Date(NOW - ageH * HOUR).toISOString() }, lastSuccessMs: NOW - ageH * HOUR, now: NOW });
  assert.equal(ok(1), 'healthy');
  assert.equal(ok(49), 'healthy');
  assert.equal(ok(49.01), 'stale');
  assert.equal(ok(200), 'stale');
  const s6 = { target: t({ schedule: { type: 'interval', everyHours: 6 } }), lastRun: null, now: NOW };
  assert.equal(targetHealth({ ...s6, lastSuccessMs: NOW - 13 * HOUR }), 'healthy');
  assert.equal(targetHealth({ ...s6, lastSuccessMs: NOW - 13.5 * HOUR }), 'stale');
});

test('targetHealth: failing, pending, disabled', () => {
  const failed = { status: 'failed', startedAt: new Date(NOW - HOUR).toISOString() };
  assert.equal(targetHealth({ target: t(), lastRun: failed, lastSuccessMs: NOW - 5 * HOUR, now: NOW }), 'failing');
  assert.equal(targetHealth({ target: t(), lastRun: failed, lastSuccessMs: null, now: NOW }), 'failing');
  // an old failure followed by a newer success is not failing
  assert.equal(targetHealth({ target: t(), lastRun: { status: 'success', startedAt: new Date(NOW - HOUR).toISOString() }, lastSuccessMs: NOW - HOUR, now: NOW }), 'healthy');
  assert.equal(targetHealth({ target: t({ createdAt: new Date(NOW - HOUR).toISOString() }), lastRun: null, lastSuccessMs: null, now: NOW }), 'pending');
  assert.equal(targetHealth({ target: t({ createdAt: new Date(NOW - 60 * HOUR).toISOString() }), lastRun: null, lastSuccessMs: null, now: NOW }), 'stale');
  assert.equal(targetHealth({ target: t({ enabled: false }), lastRun: failed, lastSuccessMs: null, now: NOW }), 'disabled');
});

test('overallHealth precedence', () => {
  assert.equal(overallHealth([]), 'healthy');
  assert.equal(overallHealth(['healthy', 'pending', 'disabled']), 'healthy');
  assert.equal(overallHealth(['healthy', 'stale']), 'stale');
  assert.equal(overallHealth(['stale', 'failing', 'healthy']), 'failing');
});
