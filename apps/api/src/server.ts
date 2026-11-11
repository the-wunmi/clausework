import { runMigrations } from '@clausework/db/migrate';
import {
  createEngine,
  ensureOwnerKey,
  launchWorkflows,
  runHourlyNow,
  shutdownWorkflows,
} from '@clausework/engine';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

await runMigrations();
const engine = await createEngine();
const firstKey = await ensureOwnerKey(engine.db, process.env.CLAUSEWORK_OWNER_KEY);
if (firstKey) {
  // Shown once: only its hash is kept. `pnpm owner-key:reset` makes a new one.
  console.warn(
    `\n  Owner key for this workspace (shown once, keep it safe):\n\n    ${firstKey}\n\n  Sign in with it at ${engine.publicUrl}/login\n`,
  );
}
// Resumes any workflow a previous stop interrupted, then runs the hourly rules and the PayPal
// checks on their schedules.
await launchWorkflows(engine, { schedules: true });
// Days missed while the server was down run now rather than at the next hour.
await runHourlyNow();

const port = Number(process.env.PORT ?? 4100);
const server = serve({ fetch: createApp(engine).fetch, port }, () => {
  engine.log(`API on http://localhost:${port}`, {
    paypal: engine.gateway.mode,
    model: engine.agents?.model ?? 'none (rules only)',
  });
});

const shutdown = async () => {
  // Stop taking requests and let those in flight finish, then stop the workflows, then the lanes.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await shutdownWorkflows();
  await engine.lanes.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
