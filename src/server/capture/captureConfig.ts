import { z } from 'zod';
import { createHash } from 'node:crypto';

export const DEFAULT_UA = 'ChangeWatch/1.0 (student project; VIT Vellore; contact: see CONTACT_EMAIL)';

export const CaptureConfigSchema = z.object({
  engine: z.literal('playwright').default('playwright'),   // 'http_dom' is STRETCH
  viewport: z.object({
    width: z.number().int().min(320).max(3840).default(1280),
    height: z.number().int().min(240).max(2160).default(720),
  }).default({ width: 1280, height: 720 }),
  deviceScaleFactor: z.number().min(1).max(2).default(1),
  jsEnabled: z.boolean().default(true),
  userAgent: z.string().min(1).max(300).default(DEFAULT_UA),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  timezone: z.string().max(64).optional(),
  waitStrategy: z.object({
    waitForSelector: z.string().max(300).optional(),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  }).default({ timeoutMs: 10000 }),
}).strict(); // unknown keys (e.g. customHeaders, cookies) are REJECTED

export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;

/**
 * Sorts object keys recursively and drops undefined values so key order
 * never alters the output string or its resulting cryptographic hash.
 */
export function canonicalStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v);
  }

  if (Array.isArray(v)) {
    return '[' + v.map(item => canonicalStringify(item)).join(',') + ']';
  }

  const obj = v as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();

  const pairs = sortedKeys.map(k => {
    return JSON.stringify(k) + ':' + canonicalStringify(obj[k]);
  });

  return '{' + pairs.join(',') + '}';
}

/**
 * Parses raw input against CaptureConfigSchema, filling defaults, and computes
 * a deterministic SHA-256 fingerprint.
 */
export function captureFingerprint(raw: unknown): { config: CaptureConfig; fingerprint: string } {
  const config = CaptureConfigSchema.parse(raw ?? {});
  const canonical = canonicalStringify(config);
  const fingerprint = createHash('sha256').update(canonical).digest('hex');
  return { config, fingerprint };
}
