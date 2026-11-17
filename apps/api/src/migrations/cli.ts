import { join } from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from '../config';
import { runMigrations } from './runner';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: loadConfig().databaseUrl, max: 1 });
  try {
    const applied = await runMigrations(pool, MIGRATIONS_DIR);
    console.log(
      applied.length === 0
        ? 'Database is up to date.'
        : `Applied migrations: ${applied.join(', ')}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
