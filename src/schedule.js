// Schedule maths: pure functions, the caller passes "now".
import { localParts, zonedToUtc, addDays } from './tz.js';

export const HOUR = 3_600_000;
export const FAILURE_RETRY_MS = HOUR; // wait this long after a failed run before retrying

export function validateSchedule(s) {
  if (!s || typeof s !== 'object') return 'schedule must be an object';
  if (s.type === 'daily') {
    if (typeof s.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return 'schedule.time must be HH:MM (24h)';
    return null;
  }
  if (s.type === 'interval') {
    if (!Number.isInteger(s.everyHours) || s.everyHours < 1 || s.everyHours > 24 * 31) return 'schedule.everyHours must be an integer between 1 and 744';
    return null;
  }
  return 'schedule.type must be "daily" or "interval"';
}

export function normalizeSchedule(s) {
  return s.type === 'daily' ? { type: 'daily', time: s.time } : { type: 'interval', everyHours: s.everyHours };
}

export function intervalMs(s) {
  return s.type === 'daily' ? 24 * HOUR : s.everyHours * HOUR;
}

/** Most recent daily slot (instant) at or before `now`. */
export function latestDailySlot(time, tz, now) {
  const [hh, mm] = time.split(':').map(Number);
  const lp = localParts(now, tz);
  let slot = zonedToUtc(lp.year, lp.month, lp.day, hh, mm, tz);
  if (slot > now) {
    const y = addDays(lp.year, lp.month, lp.day, -1);
    slot = zonedToUtc(y.year, y.month, y.day, hh, mm, tz);
  }
  return slot;
}

export function nextDailySlotAfter(time, tz, instant) {
  const [hh, mm] = time.split(':').map(Number);
  const lp = localParts(instant, tz);
  let slot = zonedToUtc(lp.year, lp.month, lp.day, hh, mm, tz);
  if (slot <= instant) {
    const n = addDays(lp.year, lp.month, lp.day, 1);
    slot = zonedToUtc(n.year, n.month, n.day, hh, mm, tz);
  }
  return slot;
}

/**
 * Is the target due right now?
 * @param lastSuccessMs  start time of the last successful backup (or null)
 * @param lastFailureMs  time of the last failed run IF it is newer than the last success (else null)
 */
export function isDue({ schedule, tz, now, lastSuccessMs = null, lastFailureMs = null }) {
  if (lastFailureMs != null && now < lastFailureMs + FAILURE_RETRY_MS) return false; // back-off after failure
  return dueBySchedule({ schedule, tz, now, lastSuccessMs });
}

function dueBySchedule({ schedule, tz, now, lastSuccessMs }) {
  if (lastSuccessMs == null) return true; // never backed up: do it right away
  if (schedule.type === 'interval') return now >= lastSuccessMs + schedule.everyHours * HOUR;
  const slot = latestDailySlot(schedule.time, tz, now);
  return lastSuccessMs < slot; // latest slot not yet served => run now (also covers catch-up after downtime)
}

/** When will the next automatic run happen? (epoch ms; <= now means "as soon as possible") */
export function nextRunAt({ schedule, tz, now, lastSuccessMs = null, lastFailureMs = null }) {
  let t;
  if (dueBySchedule({ schedule, tz, now, lastSuccessMs })) t = now;
  else if (schedule.type === 'interval') t = lastSuccessMs + schedule.everyHours * HOUR;
  else t = nextDailySlotAfter(schedule.time, tz, now);
  if (lastFailureMs != null) t = Math.max(t, lastFailureMs + FAILURE_RETRY_MS);
  return t;
}
