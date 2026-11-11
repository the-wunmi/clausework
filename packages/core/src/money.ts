import { z } from 'zod';

/** ISO 4217 code. Amounts are always integer minor units (bigint), never floats. */
export const Currency = z.string().regex(/^[A-Z]{3}$/);
export type Currency = z.infer<typeof Currency>;

const MINOR_UNITS: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, BHD: 3, KWD: 3 };

export function minorUnits(currency: Currency): number {
  return MINOR_UNITS[currency] ?? 2;
}

export interface Money {
  amount: bigint;
  currency: Currency;
}

/** Far above any real payment, and low enough that totals cannot overflow a Postgres bigint. */
export const MAX_MINOR = 1_000_000_000_000_000n;

/**
 * Whole minor units, from a bigint, an integer or a numeric string ("1400000" = €14,000.00). The
 * schema that agents read describes only what JSON can carry, because JSON Schema has no bigint.
 */
export const MinorAmount = z
  .preprocess(
    (v) => (typeof v === 'bigint' ? v.toString() : v),
    z.union([z.int(), z.string().regex(/^-?\d{1,16}$/)]),
  )
  .transform((v) => BigInt(v))
  .refine((v) => v <= MAX_MINOR && v >= -MAX_MINOR, {
    message: 'Amount is too large',
  }) as unknown as z.ZodType<bigint, bigint | number | string>;

export function money(amount: bigint | number, currency: Currency): Money {
  return { amount: BigInt(amount), currency };
}

/** Parse a major-unit decimal string ("14000.50") into minor units without floating point. */
export function fromMajor(value: string, currency: Currency): bigint {
  const digits = minorUnits(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid amount: ${value}`);
  const [, sign, whole = '0', frac = ''] = match;
  if (frac.length > digits) throw new Error(`Too many decimals for ${currency}: ${value}`);
  const minor = BigInt(whole + frac.padEnd(digits, '0'));
  return sign ? -minor : minor;
}

export function toMajor(amount: bigint, currency: Currency): string {
  const digits = minorUnits(currency);
  const neg = amount < 0n;
  const s = (neg ? -amount : amount).toString().padStart(digits + 1, '0');
  const out = digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  return neg ? `-${out}` : out;
}

/** Multiply by a rate expressed in basis points, rounding half away from zero. */
export function applyBps(amount: bigint, bps: bigint | number): bigint {
  const product = amount * BigInt(bps);
  const q = product / 10_000n;
  const r = product % 10_000n;
  const absR = r < 0n ? -r : r;
  if (absR * 2n >= 10_000n) return q + (product < 0n ? -1n : 1n);
  return q;
}

export function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
