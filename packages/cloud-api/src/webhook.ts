/**
 * Webhook HTTP plumbing: raw-body reading and X-Hub-Signature-256 validation.
 * Kept separate from the transport so the security-critical pieces are trivially
 * unit-testable.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Default cap on webhook body size. Real Cloud API events are small (<100 KB)
 * JSON documents, and this buffering happens before authentication — keep it low.
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Read a request stream fully into a Buffer. Rejects if the stream errors or the
 * body exceeds `maxBytes` (default 1 MiB).
 */
export function readRawBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`Webhook body exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/**
 * Compute the expected `X-Hub-Signature-256` header value for a raw webhook body:
 * `sha256=` + hex HMAC-SHA256 of the exact raw bytes keyed with the app secret.
 */
export function computeSignature(appSecret: string, rawBody: Buffer): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

/**
 * Timing-safe verification of a webhook `X-Hub-Signature-256` header against the
 * raw body bytes. Both sides are SHA-256 hashed first to equalize lengths (a
 * requirement of `timingSafeEqual` that also avoids leaking length information).
 * Returns false for a missing header.
 */
export function verifySignature(
  appSecret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = computeSignature(appSecret, rawBody);
  const a = createHash('sha256').update(signatureHeader).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
