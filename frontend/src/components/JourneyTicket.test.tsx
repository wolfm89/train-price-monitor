import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import JourneyTicket, { Journey } from './JourneyTicket';

const monitor: Journey = {
  id: 'j1',
  limitPrice: 50,
  unavailable: false,
  from: 'Berlin Hbf',
  to: 'München Hbf',
  fromId: '8011160',
  toId: '8000261',
  firstClass: false,
  bike: false,
  deutschlandTicketDiscount: false,
  ageGroup: 'ADULT',
  loyaltyCard: null,
  journey: {
    refreshToken: 'token',
    departure: '2030-01-15T09:00:00.000Z',
    arrival: '2030-01-15T13:00:00.000Z',
    means: ['ICE'],
    price: 42,
  },
};

describe('JourneyTicket bahn.de link', () => {
  it('links to a prefilled bahn.de search in a new tab', () => {
    render(<JourneyTicket monitor={monitor} onOpenMenu={vi.fn()} loadingIds={new Set()} />);

    const link = screen.getByRole('link', { name: 'Buy ticket on bahn.de (opens in new tab)' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    const params = new URLSearchParams(new URL(link.getAttribute('href')!).hash.slice(1));
    expect(params.get('so')).toBe('Berlin Hbf');
    expect(params.get('zo')).toBe('München Hbf');
    expect(params.get('hd')).toBe('2030-01-15T10:00:00');
    expect(params.get('kl')).toBe('2');
    expect(params.get('soei')).toBe('8011160');
    expect(params.get('zoei')).toBe('8000261');
  });

  it('does not render a link when the journey snapshot is unavailable', () => {
    render(
      <JourneyTicket
        monitor={{ ...monitor, unavailable: true, journey: null }}
        onOpenMenu={vi.fn()}
        loadingIds={new Set()}
      />
    );

    expect(screen.queryByRole('link', { name: 'Buy ticket on bahn.de (opens in new tab)' })).not.toBeInTheDocument();
  });
});
