/**
 * Calendar days and instants. A contract's dates are calendar days (YYYY-MM-DD) with no time or
 * zone; which day it is "today", and the instant a day starts, depend on the workspace's IANA time
 * zone. Instants always carry an offset.
 */

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
const partFormats = new Map<string, Intl.DateTimeFormat>();

function cached(
  cache: Map<string, Intl.DateTimeFormat>,
  zone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let f = cache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, ...options });
    cache.set(zone, f);
  }
  return f;
}

/** The calendar day (YYYY-MM-DD) an instant falls on in a zone. */
export function dayIn(instant: Date, zone: string): string {
  return cached(dayFormats, zone, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instant,
  );
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: Date, zone: string): number {
  const parts = cached(partFormats, zone, {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant a calendar day starts in a zone. Where a daylight-saving change skips midnight, the
 * day starts at the first instant that exists.
 */
export function startOfDay(day: string, zone: string): Date {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(midnightUtc)) throw new RangeError(`Not a calendar day: ${day}`);
  const guess = midnightUtc - offsetAt(new Date(midnightUtc), zone);
  const settled = midnightUtc - offsetAt(new Date(guess), zone);
  return new Date(dayIn(new Date(settled), zone) === day ? settled : guess);
}

/**
 * Parses a timestamp that states its offset: `Z`, `+01:00`, or PayPal's `+0000`. A timestamp with
 * no offset is refused, because its instant would depend on the server's zone.
 */
export function parseInstant(text: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})$/.exec(
    text.trim(),
  );
  if (!m) throw new RangeError(`Not a timestamp with an offset: ${text}`);
  const offset = m[2] === 'Z' ? 'Z' : (m[2] as string).replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const at = new Date(`${m[1]}${offset}`);
  if (Number.isNaN(at.getTime())) throw new RangeError(`Not a timestamp with an offset: ${text}`);
  return at;
}
