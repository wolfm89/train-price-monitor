import { describe, expect, it } from 'vitest';

import { buildBahnDeTicketUrl } from './bahnLink';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function paramsFrom(url: string): URLSearchParams {
  return new URLSearchParams(new URL(url).hash.slice(1));
}

describe('buildBahnDeTicketUrl', () => {
  it('builds a prefilled bahn.de search from the watchlist snapshot', () => {
    const url = buildBahnDeTicketUrl(
      {
        from: 'Berlin Hbf',
        to: 'München Hbf',
        fromId: '8011160',
        toId: '8000261',
        departure: '2030-01-15T09:00:00.000Z',
        firstClass: false,
        deutschlandTicketDiscount: false,
      },
      NOW
    );

    expect(url).toMatch(/^https:\/\/www\.bahn\.de\/buchung\/fahrplan\/suche#/);
    const params = paramsFrom(url!);
    expect(params.get('sts')).toBe('true');
    expect(params.get('so')).toBe('Berlin Hbf');
    expect(params.get('zo')).toBe('München Hbf');
    expect(params.get('kl')).toBe('2');
    expect(params.get('hd')).toBe('2030-01-15T10:00:00');
    expect(params.get('hza')).toBe('D');
    expect(params.get('soei')).toBe('8011160');
    expect(params.get('zoei')).toBe('8000261');
    expect(params.get('soid')).toContain('@O=Berlin Hbf@');
    expect(params.get('soid')).toContain('@L=8011160@');
    expect(params.get('zoid')).toContain('@L=8000261@');
    expect(params.get('dltv')).toBe('false');
  });

  it('uses first class and the Deutschland-Ticket flag when set', () => {
    const url = buildBahnDeTicketUrl(
      {
        from: 'Berlin Hbf',
        to: 'München Hbf',
        departure: '2030-07-15T09:00:00.000Z',
        firstClass: true,
        deutschlandTicketDiscount: true,
      },
      NOW
    );

    const params = paramsFrom(url!);
    expect(params.get('kl')).toBe('1');
    expect(params.get('hd')).toBe('2030-07-15T11:00:00');
    expect(params.get('dltv')).toBe('true');
  });

  it('passes a full DB station ID through unchanged', () => {
    const stationId = 'A=1@O=Berlin Hbf@X=13369549@Y=52525589@U=80@L=8011160@B=1@p=1696451873@';
    const url = buildBahnDeTicketUrl(
      {
        from: 'Berlin Hbf',
        to: 'München Hbf',
        fromId: stationId,
        departure: '2030-01-15T09:00:00.000Z',
      },
      NOW
    );

    const params = paramsFrom(url!);
    expect(params.get('soid')).toBe(stationId);
    expect(params.get('soei')).toBe('8011160');
  });

  it('falls back to the station name when no ID is stored', () => {
    const url = buildBahnDeTicketUrl(
      {
        from: 'Berlin Hbf',
        to: 'München Hbf',
        departure: '2030-01-15T09:00:00.000Z',
      },
      NOW
    );

    const params = paramsFrom(url!);
    expect(params.get('soid')).toBe('O=Berlin Hbf');
    expect(params.get('zoid')).toBe('O=München Hbf');
    expect(params.get('soei')).toBeNull();
    expect(params.get('zoei')).toBeNull();
  });

  it('returns null when the snapshot lacks a route or departure', () => {
    expect(buildBahnDeTicketUrl({ to: 'München Hbf', departure: '2030-01-15T09:00:00.000Z' })).toBeNull();
    expect(buildBahnDeTicketUrl({ from: 'Berlin Hbf', to: 'München Hbf' })).toBeNull();
    expect(buildBahnDeTicketUrl({ from: 'Berlin Hbf', to: 'München Hbf', departure: 'not-a-date' })).toBeNull();
  });
});
