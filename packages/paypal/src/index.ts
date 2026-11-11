import type { PayPalGateway } from './gateway.ts';
import { LIVE_BASE_URL, PayPalRest, SANDBOX_BASE_URL } from './rest.ts';

export * from './gateway.ts';
export * from './money.ts';
export * from './rest.ts';
export * from './simulator.ts';

export interface GatewayEnv {
  PAYPAL_MODE?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_BASE_URL?: string;
  /** "true" to try Usage-Based Billing, which PayPal enables per account (limited release). */
  PAYPAL_USAGE_BILLING?: string;
}

/**
 * PayPal for the environment: sandbox or live. Both need credentials and refuse to start without
 * them. The simulator (`PayPalSimulator`) is for tests and is never chosen by configuration.
 */
export function createGateway(env: GatewayEnv): PayPalGateway {
  const mode = (env.PAYPAL_MODE ?? 'sandbox').toLowerCase();
  if (mode !== 'sandbox' && mode !== 'live') {
    throw new Error(`PAYPAL_MODE must be sandbox or live, not "${env.PAYPAL_MODE}"`);
  }
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new Error(
      `PAYPAL_MODE=${mode} needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (from developer.paypal.com, Apps & Credentials)`,
    );
  }
  return new PayPalRest({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    webhookId: env.PAYPAL_WEBHOOK_ID || undefined,
    mode,
    baseUrl: env.PAYPAL_BASE_URL || (mode === 'live' ? LIVE_BASE_URL : SANDBOX_BASE_URL),
    usageBilling: env.PAYPAL_USAGE_BILLING === 'true',
  });
}
