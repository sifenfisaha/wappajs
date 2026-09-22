/**
 * Webhook HTTP plumbing: raw-body reading, form-body parsing and
 * X-Twilio-Signature computation/validation. Kept separate from the transport
 * so the security-critical pieces are trivially unit-testable.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Default cap on webhook body size. Real Twilio webhooks are small (<100 KB)
 * form-encoded documents, and this buffering happens before authentication —
 * keep it low.
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
 * Parse an `application/x-www-form-urlencoded` body into a plain param bag.
 * Values are fully percent-decoded; a repeated name keeps its last value
 * (matching what Twilio's own request validator hashes).
 */
export function parseFormBody(raw: Buffer): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(raw.toString('utf8'))) {
    params[name] = value;
  }
  return params;
}

/**
 * Compute the expected `X-Twilio-Signature` header value — Twilio's documented
 * scheme: sort the POST parameter names alphabetically, concatenate
 * `url + name1 + value1 + name2 + value2 + ...` (decoded values, no separators),
 * HMAC-SHA1 that string with the auth token, base64-encode the digest.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, name) => acc + name + (params[name] ?? ''), url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

/**
 * Timing-safe verification of a webhook `X-Twilio-Signature` header against the
 * exact public URL Twilio requested and the decoded POST parameters. Both sides
 * are SHA-256 hashed first to equalize lengths (a requirement of
 * `timingSafeEqual` that also avoids leaking length information). Returns false
 * for a missing header.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  const a = createHash('sha256').update(signatureHeader).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
