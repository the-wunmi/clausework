import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A db handle or an open transaction — repositories accept either. */
export type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export function createPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString: url, max: 10 });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
