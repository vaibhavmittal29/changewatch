import crypto from 'node:crypto';
import { getDb, closeDb } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrate.js';
import { hashPassword } from '../src/server/auth/password.js';

async function seed() {
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
    console.error('[SECURITY ERROR] scripts/seed.ts cannot be executed in production without explicit --force flag.');
    console.error('Refusing to seed default demo credentials into a production database.');
    process.exit(1);
  }

  console.log('Seeding ChangeWatch database...');
  const db = getDb();
  migrate(db);

  const demoEmail = 'demo@changewatch.local';
  const demoPass = 'Password123!';
  const demoName = 'ChangeWatch Demo User';

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(demoEmail) as { id: string } | undefined;

  if (existing) {
    console.log(`Demo user already exists: ${demoEmail} (ID: ${existing.id})`);
  } else {
    const userId = crypto.randomUUID();
    const { hash, salt, iterations } = await hashPassword(demoPass);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name, digest_enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(userId, demoEmail, hash, salt, iterations, demoName, now);

    console.log(`Created demo user:`);
    console.log(`  Email:    ${demoEmail}`);
    console.log(`  Password: ${demoPass}`);
    console.log(`  Name:     ${demoName}`);
    console.log(`  User ID:  ${userId}`);
  }

  closeDb();
  console.log('Database seeding completed successfully.');
}

seed().catch(err => {
  console.error('Seeding error:', err);
  process.exit(1);
});
