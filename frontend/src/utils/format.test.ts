import { describe, expect, it } from 'vitest';
import { formatCurrency, formatDate, formatDuration, formatInputDate, formatTime } from './format';

describe('formatCurrency', () => {
  it('formats EUR amounts for the English UI', () => {
    expect(formatCurrency(12.5)).toBe('€12.50');
    expect(formatCurrency(0)).toBe('€0.00');
    expect(formatCurrency(1234.5)).toBe('€1,234.50');
  });

  it('accepts Intl overrides', () => {
    expect(formatCurrency(1234.5, { maximumFractionDigits: 0 })).toBe('€1,235');
  });

  it('returns an em dash for non-finite values', () => {
    expect(formatCurrency(Number.NaN)).toBe('—');
  });
});

describe('formatDate and formatTime', () => {
  it('formats dates in Berlin time', () => {
    expect(formatDate('2026-01-15T12:00:00Z')).toBe('15 Jan 2026');
    expect(formatDate('2026-07-15T12:00:00Z')).toBe('15 Jul 2026');
  });

  it('formats times in Berlin time across the DST boundary', () => {
    expect(formatTime('2026-03-29T00:30:00Z')).toBe('01:30');
    expect(formatTime('2026-03-29T01:30:00Z')).toBe('03:30');
  });

  it('formats a date for a native input', () => {
    expect(formatInputDate('2026-03-29T01:30:00Z')).toBe('2026-03-29');
  });

  it('returns an em dash for invalid input', () => {
    expect(formatDate('not-a-date')).toBe('—');
    expect(formatTime('not-a-date')).toBe('—');
    expect(formatInputDate('not-a-date')).toBe('');
  });
});

describe('formatDuration', () => {
  it('formats short durations in minutes', () => {
    expect(formatDuration('2026-11-13T10:00:00Z', '2026-11-13T10:45:00Z')).toBe('45m');
  });

  it('zero-pads minutes when hours are present', () => {
    expect(formatDuration('2026-11-13T10:00:00Z', '2026-11-13T11:05:00Z')).toBe('1h 05m');
  });

  it('returns an em dash for invalid input', () => {
    expect(formatDuration('not-a-date', '2026-11-13T11:05:00Z')).toBe('—');
  });
});
