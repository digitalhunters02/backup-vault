// S3-compatible storage wrapper (AWS S3, Backblaze B2, MinIO...). Everything else talks to this small interface.
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';

const isNotFound = (e) => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;

export class S3Storage {
  constructor(cfg) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // Newer SDK versions add CRC32 checksums by default, which several S3-compatible services reject.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 4,
    });
  }

  async putJson(key, obj) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: JSON.stringify(obj, null, 2), ContentType: 'application/json',
    }));
  }

  async getText(key) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return await r.Body.transformToString();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async getJson(key) {
    const t = await this.getText(key);
    return t == null ? null : JSON.parse(t);
  }

  /** All objects under prefix: [{key,size,lastModified(ms)}] */
  async list(prefix) {
    const out = [];
    let token;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) out.push({ key: o.Key, size: Number(o.Size ?? 0), lastModified: o.LastModified ? new Date(o.LastModified).getTime() : 0 });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async head(key) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Multipart streaming upload. 8 MiB parts x 2 in flight => ~16 MiB of memory regardless of file size. */
  async upload(key, body, { contentType = 'application/octet-stream' } = {}) {
    const up = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
      partSize: 8 * 1024 * 1024,
      queueSize: 2,
      leavePartsOnError: false,
    });
    await up.done();
  }

  async presignGet(key, { expiresIn = 600, filename } = {}) {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ResponseContentDisposition: filename ? `attachment; filename="${filename.replace(/"/g, '')}"` : undefined,
    });
    return getSignedUrl(this.client, cmd, { expiresIn });
  }

  /** write + read + delete a tiny object. */
  async selfTest(prefix) {
    const key = `${prefix}/_vault/selftest-${crypto.randomBytes(6).toString('hex')}.txt`;
    const payload = `backup-vault selftest ${new Date().toISOString()}`;
    const steps = {};
    const t0 = Date.now();
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: payload, ContentType: 'text/plain' }));
      steps.write = true;
      const got = await this.getText(key);
      steps.read = got === payload;
      if (!steps.read) throw new Error('read back a different content than was written');
      await this.delete(key);
      steps.delete = (await this.head(key)) === null;
      if (!steps.delete) throw new Error('object still exists after delete');
      return { ok: true, steps, latencyMs: Date.now() - t0 };
    } catch (e) {
      try { await this.delete(key); } catch { /* best effort */ }
      return { ok: false, steps, error: e?.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : String(e?.message ?? e), latencyMs: Date.now() - t0 };
    }
  }
}
