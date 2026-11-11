import type { z } from 'zod';

export type DomainErrorCode = 'not_found' | 'conflict' | 'invalid' | 'forbidden' | 'unavailable';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Every input from outside passes through here, so a bad one is always the same kind of error. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DomainError('invalid', 'Invalid input', parsed.error.issues);
  return parsed.data;
}
