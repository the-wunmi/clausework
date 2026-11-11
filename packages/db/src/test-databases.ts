import { existsSync } from 'node:fs';
import pg from 'pg';

/**
 * Empty databases for one package's test run, so tests never touch the dev databases a running
 * server works from: the app database and the DBOS system database that records workflows.
 */
export async function freshTestDatabase(suite: string): Promise<Record<string, string>> {
  const rootEnv = new URL('../../../.env', import.meta.url).pathname;
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set (see .env.example)');
  const name = `clausework_test_${suite}`;
  const system = `${name}_dbos`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    for (const db of [name, system]) {
      await admin.query(`drop database if exists ${db} with (force)`);
      await admin.query(`create database ${db}`);
    }
  } finally {
    await admin.end();
  }
  const at = (db: string) => {
    const url = new URL(base);
    url.pathname = `/${db}`;
    return url.toString();
  };
  return { DATABASE_URL: at(name), DBOS_SYSTEM_DATABASE_URL: at(system) };
}
