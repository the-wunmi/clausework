import { readFileSync, writeFileSync } from 'node:fs';
import { HANDLED_EVENTS } from '@clausework/engine';
import { PayPalRest } from '@clausework/paypal';

// Points this PayPal app's webhook at the server and saves its id to .env.
// Usage: pnpm webhook:register https://your-public-host
const ENV_FILE = new URL('../../../.env', import.meta.url).pathname;
const [host] = process.argv.slice(2);
if (!host?.startsWith('https://')) {
  throw new Error('Usage: pnpm webhook:register https://your-public-host (PayPal needs HTTPS)');
}
const { PAYPAL_MODE = 'sandbox', PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (PAYPAL_MODE !== 'sandbox' && PAYPAL_MODE !== 'live') {
  throw new Error(`PAYPAL_MODE must be sandbox or live, not "${PAYPAL_MODE}"`);
}
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env');
}
const mode = PAYPAL_MODE;
const id = await new PayPalRest({
  clientId: PAYPAL_CLIENT_ID,
  clientSecret: PAYPAL_CLIENT_SECRET,
  mode,
  baseUrl: process.env.PAYPAL_BASE_URL || undefined,
}).registerWebhook(`${host.replace(/\/$/, '')}/api/webhooks/paypal`, [...HANDLED_EVENTS]);

const line = `PAYPAL_WEBHOOK_ID=${id}`;
const env = readFileSync(ENV_FILE, 'utf8');
const pattern = /^PAYPAL_WEBHOOK_ID=.*$/m;
writeFileSync(
  ENV_FILE,
  pattern.test(env) ? env.replace(pattern, () => line) : `${env.trimEnd()}\n${line}\n`,
);
console.log(`Registered ${mode} webhook ${id} for ${HANDLED_EVENTS.length} events; saved to .env.`);
console.log('Restart the API to use it.');
