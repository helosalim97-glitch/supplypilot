import { join } from 'node:path';
import {
  checksumOf,
  parseMigrationFile,
  planMigrations,
  readMigrationFiles,
} from '../src/migrations/runner';

const file = (version: number, sql = `SELECT ${version};`) =>
  parseMigrationFile(`${String(version).padStart(4, '0')}_step_${version}.sql`, sql);

describe('migration planning', () => {
  it('parses version and name from the file name', () => {
    const parsed = parseMigrationFile('0007_add_suppliers.sql', 'SELECT 1;');
    expect(parsed.version).toBe(7);
    expect(parsed.name).toBe('add_suppliers');
    expect(parsed.checksum).toBe(checksumOf('SELECT 1;'));
  });

  it('rejects badly named files', () => {
    expect(() => parseMigrationFile('7_add.sql', '')).toThrow(/Invalid migration file name/);
    expect(() => parseMigrationFile('0007-Add.sql', '')).toThrow(/Invalid migration file name/);
  });

  it('returns pending migrations in version order', () => {
    const pending = planMigrations([file(3), file(1), file(2)], []);
    expect(pending.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it('skips migrations that were already applied', () => {
    const one = file(1);
    const pending = planMigrations([one, file(2)], [{ version: 1, checksum: one.checksum }]);
    expect(pending.map((m) => m.version)).toEqual([2]);
  });

  it('refuses an applied migration whose SQL changed', () => {
    const applied = [{ version: 1, checksum: checksumOf('SELECT 1;') }];
    expect(() => planMigrations([file(1, 'SELECT 2;')], applied)).toThrow(/changed after it was applied/);
  });

  it('refuses an applied migration that is missing on disk', () => {
    const applied = [{ version: 5, checksum: checksumOf('x') }];
    expect(() => planMigrations([file(1)], applied)).toThrow(/missing from the migrations folder/);
  });

  it('refuses duplicate versions', () => {
    const dup = parseMigrationFile('0001_other.sql', 'SELECT 9;');
    expect(() => planMigrations([file(1), dup], [])).toThrow(/Duplicate migration version 1/);
  });

  it('reads the committed migrations folder', async () => {
    const files = await readMigrationFiles(join(__dirname, '..', 'migrations'));
    expect(files[0]).toMatchObject({ version: 1, name: 'baseline' });
  });
});
