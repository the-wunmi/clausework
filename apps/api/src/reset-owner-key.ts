import { createDb, createPool } from '@clausework/db';
import { resetOwnerKey } from '@clausework/engine';

/** The way back in after losing the owner key. The old key and every signed-in browser stop working. */
if (process.env.CLAUSEWORK_OWNER_KEY) {
  // The server would put that key back on its next start.
  throw new Error('CLAUSEWORK_OWNER_KEY is set in .env: change it there and restart the API');
}
const pool = createPool(process.env.DATABASE_URL);
const key = await resetOwnerKey(createDb(pool));
console.log(`\n  New owner key (shown once, keep it safe):\n\n    ${key}\n`);
await pool.end();
