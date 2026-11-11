import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  // Only commands that connect use this (`generate` does not); migrations run through `pnpm db:migrate`.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
