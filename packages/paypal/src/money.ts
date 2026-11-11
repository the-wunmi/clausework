import { fromMajor, toMajor } from '@clausework/core';
import type { Money } from './gateway.ts';

/** PayPal's money object: `{ currency_code, value }` with a decimal string. */
export interface PayPalAmount {
  currency_code: string;
  value: string;
}

export const toPayPal = (m: Money): PayPalAmount => ({
  currency_code: m.currency,
  value: toMajor(m.amount, m.currency),
});

export function fromPayPal(a: { currency_code?: string; currency?: string; value: string }): Money {
  const currency = (a.currency_code ?? a.currency ?? 'USD').toUpperCase();
  return { currency, amount: fromMajor(a.value, currency) };
}

/** Up to two decimals, as PayPal's invoice quantities and our usage quantities allow. */
export const quantityString = (q: number): string =>
  Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
