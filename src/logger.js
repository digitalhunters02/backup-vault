import { redact } from './redact.js';

/** Line logger; every message is redacted. `sink` can be replaced in tests. */
export function createLogger({ sink = (line, level) => (level === 'error' || level === 'warn' ? console.error(line) : console.log(line)), quiet = false } = {}) {
  const emit = (level, msg, extra) => {
    if (quiet) return;
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    if (extra !== undefined) {
      let e;
      try { e = typeof extra === 'string' ? extra : JSON.stringify(extra); } catch { e = String(extra); }
      line += ' ' + e;
    }
    sink(redact(line), level);
  };
  return {
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}
