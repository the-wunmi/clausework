import { createHash, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Links and sessions store only this hash of their token. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
