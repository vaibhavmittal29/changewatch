import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'node:path';

// Load environment variables from .env if present
dotenv.config();

function calculateEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const c of str) freq[c] = (freq[c] || 0) + 1;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  BASE_URL: z.string().transform(val => {
    if (!val || val === '/' || val === './') {
      return 'http://localhost:3000';
    }
    return val;
  }).refine(val => {
    try {
      new URL(val);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid URL').default('http://localhost:3000'),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters long').optional(),
  DATABASE_PATH: z.string().default('./data/changewatch.db'),
  DATA_DIR: z.string().default('./data'),
  CONTACT_EMAIL: z.string().email().default('contact@changewatch.local'),
  PBKDF2_ITERATIONS: z.coerce.number().int().min(1000).default(600000),
  TICK_MS: z.coerce.number().int().min(1000).default(30000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  DOMAIN_GAP_MS: z.coerce.number().int().min(1000).default(10000),
  CONFIRM_DELAY_MS: z.coerce.number().int().min(1000).default(120000),
  SHARED_CAPTURE_TTL_MS: z.coerce.number().int().min(1000).default(15000),
  COOLDOWN_HOURS: z.coerce.number().min(0.1).default(6),
  OUTAGE_THRESHOLD: z.coerce.number().int().min(1).default(3),
  MAX_SUBS_PER_USER: z.coerce.number().int().min(1).default(25),
  OBSERVATION_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  TZ: z.string().default('UTC'),
  ALLOW_LOCAL_DEMO: z.string().transform(v => v === 'true' || v === '1').default('false'),
  DEMO_PORT: z.coerce.number().default(4000),
  DEV_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(1).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
}).superRefine((data, ctx) => {
  const PREDICTABLE_SECRETS = [
    'changewatch_super_secure_random_key_min_32_chars_long_2026',
    '12345678901234567890123456789012',
    'abcdefghijklmnopqrstuvwxyz123456',
    'dev_changewatch_local_secret_key_min_32_chars_long',
  ];
  if (data.NODE_ENV === 'production') {
    if (!data.APP_SECRET || PREDICTABLE_SECRETS.includes(data.APP_SECRET) || calculateEntropy(data.APP_SECRET) < 3.0 || new Set(data.APP_SECRET).size < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_SECRET'],
        message: 'Production requires a cryptographically random APP_SECRET (minimum 32 characters, e.g. 32+ bytes hex); default and low-complexity keys are rejected.',
      });
    }
    if (data.PBKDF2_ITERATIONS < 600000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PBKDF2_ITERATIONS'],
        message: 'Production requires PBKDF2_ITERATIONS >= 600000.',
      });
    }
  }
});

const rawEnv = {
  ...process.env,
  APP_SECRET: process.env.APP_SECRET || (process.env.NODE_ENV === 'production' ? undefined : 'dev_changewatch_local_secret_key_min_32_chars_long'),
};

export const parsed = EnvSchema.safeParse(rawEnv);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = {
  ...parsed.data,
  APP_SECRET: (parsed.data.APP_SECRET || 'dev_changewatch_local_secret_key_min_32_chars_long') as string,
  DATABASE_PATH: path.resolve(process.cwd(), parsed.data.DATABASE_PATH),
  DATA_DIR: path.resolve(process.cwd(), parsed.data.DATA_DIR),
};

export type Env = typeof env;
