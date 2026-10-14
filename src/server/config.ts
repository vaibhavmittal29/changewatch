import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'node:path';

// Load environment variables from .env if present
dotenv.config();

const EnvSchema = z.object({
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
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters long').default('changewatch_super_secure_random_key_min_32_chars_long_2026'),
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
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format(), 'BASE_URL is:', JSON.stringify(process.env.BASE_URL));
  process.exit(1);
}

export const env = {
  ...parsed.data,
  DATABASE_PATH: path.resolve(process.cwd(), parsed.data.DATABASE_PATH),
  DATA_DIR: path.resolve(process.cwd(), parsed.data.DATA_DIR),
};

export type Env = typeof env;
