import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.js';

let dbInstance: Database.Database | null = null;

/**
 * Initializes and returns the SQLite database connection.
 * Enforces WAL mode and foreign key constraints on every connection.
 */
export function getDb(customPath?: string): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = customPath || env.DATABASE_PATH;
  const dbDir = path.dirname(dbPath);

  // Ensure database directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Ensure data directories exist
  const dataDir = env.DATA_DIR;
  const screenshotsDir = path.join(dataDir, 'screenshots');
  const diffsDir = path.join(dataDir, 'diffs');
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
  if (!fs.existsSync(diffsDir)) fs.mkdirSync(diffsDir, { recursive: true });

  const db = new Database(dbPath);

  // Mandatory Pragmas per spec
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  dbInstance = db;
  return dbInstance;
}

export function setDb(db: Database.Database | null): void {
  dbInstance = db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
