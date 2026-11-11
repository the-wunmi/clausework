import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, createPool } from './client.ts';

export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  const pool = createPool(url);
  try {
    await migrate(createDb(pool), {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log('migrations applied');
}
