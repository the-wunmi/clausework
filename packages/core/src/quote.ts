/**
 * Finding a clause's quote in its source. The model reports a quote; code proves it is really
 * there. Whitespace, curly quotes and dashes differ between a PDF's text layer and a model's copy,
 * so both sides are folded, and the span maps back to the original text.
 */

const FOLD: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '−': '-',
  ' ': ' ',
  '­': '',
  '§': '§',
};

interface Folded {
  text: string;
  /** For each folded character, its index in the original. */
  origin: number[];
}

function fold(source: string): Folded {
  let text = '';
  const origin: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < source.length; i++) {
    const raw = source[i] as string;
    const ch = FOLD[raw] ?? raw;
    if (ch === '') continue;
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      text += ' ';
      origin.push(i);
      lastWasSpace = true;
      continue;
    }
    text += ch.toLowerCase();
    origin.push(i);
    lastWasSpace = false;
  }
  return { text, origin };
}

export interface Span {
  start: number;
  end: number;
}

/** The span of `quote` in `source` at or after `from`, or null when the source does not contain it. */
export function locateQuote(source: string, quote: string, from = 0): Span | null {
  const haystack = fold(source);
  const needle = fold(quote).text.trim();
  if (needle.length === 0) return null;
  const startFolded = haystack.origin.findIndex((o) => o >= from);
  if (startFolded < 0) return null;
  const at = haystack.text.indexOf(needle, startFolded);
  if (at < 0) return null;
  const start = haystack.origin[at] as number;
  const end = (haystack.origin[at + needle.length - 1] as number) + 1;
  return { start, end };
}

/** Spans for each quote in document order, so repeated wording maps to successive occurrences. */
export function locateQuotes(source: string, quotes: string[]): (Span | null)[] {
  let cursor = 0;
  return quotes.map((q) => {
    const span = locateQuote(source, q, cursor) ?? locateQuote(source, q, 0);
    if (span && span.start >= cursor) cursor = span.end;
    return span;
  });
}
