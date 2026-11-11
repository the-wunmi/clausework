import { createHash } from 'node:crypto';

/** JSON has no bigint, so amounts are written as strings of minor units. */
export const toJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const compareKeys = ([a]: [string, unknown], [b]: [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

/** Deterministic JSON: sorted keys, bigints as strings. Used for hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(compareKeys));
    }
    return v;
  });
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
