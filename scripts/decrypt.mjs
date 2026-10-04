#!/usr/bin/env node
// Decrypts a backup-vault dump (.dump.enc -> .dump).  Usage:
//   BACKUP_ENCRYPTION_KEY='your key' node scripts/decrypt.mjs <file.dump.enc> [output.dump]
//   node scripts/decrypt.mjs <file.dump.enc> --key-file ./key.txt
// Prints the SHA-256 of the result: compare it with the "sha256" field of the run record.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createDecryptStream } from '../src/crypto.js';

const args = process.argv.slice(2);
let keyFile;
const ki = args.indexOf('--key-file');
if (ki >= 0) { keyFile = args[ki + 1]; args.splice(ki, 2); }
const [input, outArg] = args;
if (!input) {
  console.error('Usage: BACKUP_ENCRYPTION_KEY=... node scripts/decrypt.mjs <file.dump.enc> [output.dump]');
  process.exit(2);
}
const key = keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
if (!key) { console.error('Error: set BACKUP_ENCRYPTION_KEY (or pass --key-file).'); process.exit(2); }
const output = outArg || input.replace(/\.enc$/, '') + (input.endsWith('.enc') ? '' : '.dec');
if (fs.existsSync(output)) { console.error(`Error: ${output} already exists; choose another name.`); process.exit(2); }

const hash = crypto.createHash('sha256');
let bytes = 0;
const tap = new Transform({ transform(c, _e, cb) { hash.update(c); bytes += c.length; cb(null, c); } });
try {
  await pipeline(fs.createReadStream(input), createDecryptStream(key), tap, fs.createWriteStream(output, { mode: 0o600 }));
  console.log(`OK: wrote ${output} (${bytes} bytes)\nsha256: ${hash.digest('hex')}`);
} catch (e) {
  fs.rmSync(output, { force: true });
  console.error(`Failed: ${e.message}`);
  process.exit(1);
}
