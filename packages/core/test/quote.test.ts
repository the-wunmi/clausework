import { describe, expect, it } from 'vitest';
import { locateQuote, locateQuotes } from '../src/quote.ts';

describe('locateQuote', () => {
  const source = 'Section 4.1  Fees.\nClient shall pay  “Agency” a monthly\nretainer of $3,000.';

  it('finds a quote despite different whitespace, quotes and case', () => {
    const span = locateQuote(source, 'client shall pay "Agency" a monthly retainer of $3,000.');
    expect(span).not.toBeNull();
    expect(source.slice(span!.start, span!.end)).toBe(
      'Client shall pay  “Agency” a monthly\nretainer of $3,000.',
    );
  });

  it('returns null for words the document does not contain', () => {
    expect(locateQuote(source, 'a monthly retainer of $4,000')).toBeNull();
  });

  it('maps repeated wording to successive occurrences', () => {
    const text = 'Pay $10. Later: Pay $10.';
    const [first, second] = locateQuotes(text, ['Pay $10.', 'Pay $10.']);
    expect(first!.start).toBe(0);
    expect(second!.start).toBe(16);
  });
});
