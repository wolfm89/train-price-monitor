import { describe, expect, it } from 'vitest';
import { exportFileName, withLoginAttributes } from './dataExport';

describe('withLoginAttributes', () => {
  it('adds the Cognito attributes next to the backend data', () => {
    const merged = JSON.parse(
      withLoginAttributes(JSON.stringify({ formatVersion: 1, account: { id: 'u1' } }), {
        email: 'jane@example.com',
        given_name: 'Jane',
      })
    );

    expect(merged).toEqual({
      formatVersion: 1,
      account: { id: 'u1' },
      login: { email: 'jane@example.com', given_name: 'Jane' },
    });
  });

  it('records a missing session explicitly', () => {
    expect(JSON.parse(withLoginAttributes('{}', null))).toEqual({ login: null });
  });
});

describe('exportFileName', () => {
  it('uses the UTC date', () => {
    expect(exportFileName(new Date('2026-11-11T23:30:00Z'))).toBe('train-price-monitor-data-2026-11-11.json');
  });
});
