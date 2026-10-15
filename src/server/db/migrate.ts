import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Runs initial database migrations, tracking schema version with user_version.
 */
export function migrate(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion === 0) {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');

    db.exec(sql);
    db.pragma('user_version = 2');
  } else if (currentVersion === 1) {
    try {
      db.exec('ALTER TABLE observations ADD COLUMN top_level_navigations INTEGER NOT NULL DEFAULT 1;');
    } catch {}
    db.pragma('user_version = 2');
  }
}
