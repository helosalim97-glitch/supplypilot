import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

/** Migration files are named `NNNN_snake_case_name.sql`, e.g. `0001_baseline.sql`. */
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  checksum: string;
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export function parseMigrationFile(fileName: string, sql: string): MigrationFile {
  const match = FILE_PATTERN.exec(fileName);
  if (!match) {
    throw new Error(`Invalid migration file name "${fileName}"; expected NNNN_name.sql`);
  }
  return { version: Number(match[1]), name: match[2], sql, checksum: checksumOf(sql) };
}

/**
 * Returns the migrations that still need to run, in version order.
 * Throws if versions are duplicated, if an applied migration is missing on disk,
 * or if an applied migration was edited after it ran (checksum drift).
 */
export function planMigrations(
  files: MigrationFile[],
  applied: AppliedMigration[],
): MigrationFile[] {
  const sorted = [...files].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].version === sorted[i - 1].version) {
      throw new Error(`Duplicate migration version ${sorted[i].version}`);
    }
  }

  const byVersion = new Map(sorted.map((file) => [file.version, file]));
  for (const done of applied) {
    const file = byVersion.get(done.version);
    if (!file) {
      throw new Error(`Applied migration ${done.version} is missing from the migrations folder`);
    }
    if (file.checksum !== done.checksum) {
      throw new Error(
        `Migration ${done.version}_${file.name} changed after it was applied; add a new migration instead`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((done) => done.version));
  return sorted.filter((file) => !appliedVersions.has(file.version));
}

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => parseMigrationFile(name, await readFile(join(dir, name), 'utf8'))),
  );
}

/** Applies pending migrations, each in its own transaction. Returns the applied versions. */
export async function runMigrations(pool: Pool, dir: string): Promise<number[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      name       text        NOT NULL,
      checksum   char(64)    NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const client = await pool.connect();
  try {
    // Serialize concurrent runners (e.g. two API replicas starting together).
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['supplypilot_migrations']);
    try {
      const { rows } = await client.query<AppliedMigration>(
        'SELECT version, checksum FROM schema_migrations ORDER BY version',
      );
      const pending = planMigrations(await readMigrationFiles(dir), rows);

      for (const migration of pending) {
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [migration.version, migration.name, migration.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      return pending.map((migration) => migration.version);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['supplypilot_migrations']);
    }
  } finally {
    client.release();
  }
}
