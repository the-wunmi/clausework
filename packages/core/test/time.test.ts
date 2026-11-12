import { describe, expect, it } from 'vitest';
import { dayIn, isTimeZone, parseInstant, startOfDay } from '../src/time.ts';

describe('time', () => {
  it('knows which day it is in a zone', () => {
    const at = new Date('2026-11-12T05:30:00Z');
    expect(dayIn(at, 'UTC')).toBe('2026-11-12');
    expect(dayIn(at, 'America/Los_Angeles')).toBe('2026-11-11');
    expect(dayIn(at, 'Africa/Lagos')).toBe('2026-11-12');
    expect(dayIn(new Date('2026-11-12T11:30:00Z'), 'Pacific/Kiritimati')).toBe('2026-11-13');
  });

  it('finds the instant a day starts, across daylight saving', () => {
    expect(startOfDay('2026-11-13', 'UTC').toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(startOfDay('2026-11-13', 'America/New_York').toISOString()).toBe(
      '2026-11-13T05:00:00.000Z',
    );
    expect(startOfDay('2026-07-01', 'America/New_York').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
    expect(startOfDay('2026-11-13', 'Asia/Kolkata').toISOString()).toBe('2026-11-12T18:30:00.000Z');
    // The clocks go back at 01:00 in Chile on 5 April 2026; midnight exists once.
    expect(dayIn(startOfDay('2026-04-05', 'America/Santiago'), 'America/Santiago')).toBe(
      '2026-04-05',
    );
    // Midnight is skipped in Chile on 6 September 2026; the day starts at 01:00.
    expect(startOfDay('2026-09-06', 'America/Santiago').toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    );
  });

  it('parses timestamps only when they state an offset', () => {
    expect(parseInstant('2026-11-12T05:01:00+0000').toISOString()).toBe('2026-11-12T05:01:00.000Z');
    expect(parseInstant('2026-11-11T21:01:00-0800').toISOString()).toBe('2026-11-12T05:01:00.000Z');
    expect(parseInstant('2026-11-12T05:01:00.123Z').toISOString()).toBe('2026-11-12T05:01:00.123Z');
    expect(() => parseInstant('2026-11-12T05:01:00')).toThrow(RangeError);
    expect(() => parseInstant('2026-11-12')).toThrow(RangeError);
  });

  it('checks zone names', () => {
    expect(isTimeZone('America/New_York')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});
