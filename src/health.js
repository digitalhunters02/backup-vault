// Stale / failing evaluation (pure).
import { HOUR, intervalMs } from './schedule.js';

export const GRACE_MS = HOUR;

/** stale if the last successful backup is older than 2x interval + 1h grace. */
export function staleAfterMs(schedule) {
  return 2 * intervalMs(schedule) + GRACE_MS;
}

/**
 * @returns 'disabled' | 'pending' | 'failing' | 'stale' | 'healthy'
 *  pending = never succeeded yet but still inside the grace window since creation
 */
export function targetHealth({ target, lastRun, lastSuccessMs, now }) {
  if (!target.enabled) return 'disabled';
  const limit = staleAfterMs(target.schedule);
  const failing = lastRun && lastRun.status === 'failed' && (lastSuccessMs == null || Date.parse(lastRun.startedAt) > lastSuccessMs);
  if (lastSuccessMs == null) {
    if (failing) return 'failing';
    const created = Date.parse(target.createdAt || '') || now;
    return now - created > limit ? 'stale' : 'pending';
  }
  if (failing) return 'failing';
  return now - lastSuccessMs > limit ? 'stale' : 'healthy';
}

/** failing > stale > healthy (pending/disabled do not degrade the global state). */
export function overallHealth(statuses) {
  if (statuses.includes('failing')) return 'failing';
  if (statuses.includes('stale')) return 'stale';
  return 'healthy';
}
