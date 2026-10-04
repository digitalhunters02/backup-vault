import { loadEnv, ConfigError } from './config.js';
import { registerSecret } from './redact.js';
import { createLogger } from './logger.js';
import { S3Storage } from './storage.js';
import { Vault } from './vault.js';
import { createApp } from './api.js';

export function buildService(env, { storage, log = createLogger() } = {}) {
  for (const s of [env.apiKey, env.configKey, env.encKey, env.s3.secretAccessKey, env.s3.accessKeyId]) registerSecret(s);
  const st = storage ?? new S3Storage({ ...env.s3 });
  const vault = new Vault({ env, storage: st, log });
  const server = createApp({ env, vault, log });
  return { env, vault, server, log };
}

async function main() {
  let env;
  try { env = loadEnv(process.env); } catch (e) {
    if (e instanceof ConfigError) { console.error(e.message + '\n\nSee .env.example'); process.exit(1); }
    throw e;
  }
  const { vault, server, log } = buildService(env);
  server.listen(env.port, '0.0.0.0', () => log.info(`backup-vault listening on :${env.port} (tz ${env.tz}, dump encryption ${env.encKey ? 'ON' : 'off'})`));
  vault.ensureReady().catch((e) => log.error(`startup: ${e.message} (will retry on the next scheduler tick)`));
  if (env.autoSchedule) vault.startScheduler();
  const stop = () => { vault.stopScheduler(); server.close(); setTimeout(() => process.exit(0), 500).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
