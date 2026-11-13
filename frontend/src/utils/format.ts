export const APP_TIME_ZONE = 'Europe/Berlin';

const CURRENCY_LOCALE = 'en-IE';
const DATE_TIME_LOCALE = 'en-GB';

const currencyFormatter = new Intl.NumberFormat(CURRENCY_LOCALE, {
  style: 'currency',
  currency: 'EUR',
});

const dateFormatter = new Intl.DateTimeFormat(DATE_TIME_LOCALE, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: APP_TIME_ZONE,
});

const timeFormatter = new Intl.DateTimeFormat(DATE_TIME_LOCALE, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: APP_TIME_ZONE,
});

const inputDateFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: APP_TIME_ZONE,
});

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats a EUR amount, e.g. `€12.50`. Returns an em dash for non-finite values. */
export function formatCurrency(value: number, options?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(value)) return '—';
  if (!options) return currencyFormatter.format(value);
  return new Intl.NumberFormat(CURRENCY_LOCALE, {
    style: 'currency',
    currency: 'EUR',
    ...options,
  }).format(value);
}

/** Formats a calendar date in Berlin time, e.g. `15 Jan 2026`. */
export function formatDate(value: string | Date): string {
  const date = toDate(value);
  return date ? dateFormatter.format(date) : '—';
}

/** Formats a date for a native date input (`YYYY-MM-DD`) in Berlin time. */
export function formatInputDate(value: string | Date): string {
  const date = toDate(value);
  return date ? inputDateFormatter.format(date) : '';
}

/** Formats a clock time in Berlin time, e.g. `14:30`. */
export function formatTime(value: string | Date): string {
  const date = toDate(value);
  return date ? timeFormatter.format(date) : '—';
}

/** Formats a journey duration with zero-padded minutes, e.g. `1h 05m`. */
export function formatDuration(departure: string | Date, arrival: string | Date): string {
  const start = toDate(departure);
  const end = toDate(arrival);
  if (!start || !end) return '—';
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0 ? `${hours}h ${remainingMinutes.toString().padStart(2, '0')}m` : `${remainingMinutes}m`;
}
