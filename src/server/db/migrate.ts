import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Checks if a table column already exists using PRAGMA table_info.
 */
export function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  try {
    const columns = db.pragma(`table_info(${tableName})`) as Array<{ name: string }>;
    return columns.some(col => col.name === columnName);
  } catch {
    return false;
  }
}

/**
 * Runs initial database migrations, tracking schema version with user_version.
 */
export function migrate(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion === 0) {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');

    db.transaction(() => {
      db.exec(sql);
      db.pragma('user_version = 3');
    })();
    return;
  }

  if (currentVersion < 3) {
    db.transaction(() => {
      if (currentVersion === 1) {
        if (!hasColumn(db, 'observations', 'top_level_navigations')) {
          db.exec('ALTER TABLE observations ADD COLUMN top_level_navigations INTEGER NOT NULL DEFAULT 1;');
        }
      }
      if (!hasColumn(db, 'subscriptions', 'feed_token')) {
        db.exec('ALTER TABLE subscriptions ADD COLUMN feed_token TEXT;');
      }
      db.pragma('user_version = 3');
    })();
  }
}
