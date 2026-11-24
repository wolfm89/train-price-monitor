import { ThemeProvider } from '@mui/material/styles';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import JourneyTicket, { Journey } from './JourneyTicket';
import { theme } from '../theme';

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

function renderTicket(ticket: Journey) {
  return render(
    <ThemeProvider theme={theme}>
      <JourneyTicket monitor={ticket} onOpenMenu={vi.fn()} loadingIds={new Set()} />
    </ThemeProvider>
  );
}

function getTicketLink(): HTMLElement {
  return screen.getByRole('link', { name: /Buy ticket on bahn\.de for Berlin Hbf to München Hbf/ });
}

describe('JourneyTicket bahn.de link', () => {
  it('links to a prefilled bahn.de search in a new tab', () => {
    renderTicket(monitor);

    const link = getTicketLink();
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName(/opens in new tab/);
    expect(link).toHaveAttribute('href', expect.stringMatching(/^https:\/\/www\.bahn\.de\/buchung\/fahrplan\/suche#/));
    expect(screen.getAllByRole('link')).toHaveLength(1);

    const params = new URLSearchParams(new URL(link.getAttribute('href')!).hash.slice(1));
    expect(params.get('so')).toBe('Berlin Hbf');
    expect(params.get('zo')).toBe('München Hbf');
    expect(params.get('hd')).toBe('2030-01-15T10:00:00');
    expect(params.get('kl')).toBe('2');
    expect(params.get('soei')).toBe('8011160');
    expect(params.get('zoei')).toBe('8000261');
  });

  it('keeps the link when the price is temporarily missing', () => {
    renderTicket({ ...monitor, journey: { ...monitor.journey!, price: null } });

    expect(getTicketLink()).toBeInTheDocument();
  });

  it('keeps the link while the snapshot is flagged unavailable but still present', () => {
    renderTicket({ ...monitor, unavailable: true });

    expect(getTicketLink()).toBeInTheDocument();
  });

  it('hides the link when the saved traveller preferences cannot be represented', () => {
    renderTicket({ ...monitor, ageGroup: 'CHILD' });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('prefills a BahnCard 25 traveller parameter', () => {
    renderTicket({ ...monitor, loyaltyCard: { type: 'BAHNCARD', discount: 25, class: 1 } });

    const params = new URLSearchParams(new URL(getTicketLink().getAttribute('href')!).hash.slice(1));
    expect(params.get('r')).toBe('13:17:KLASSE_1:1');
  });

  it('falls back to the name-only station parameter without stored IDs', () => {
    renderTicket({ ...monitor, fromId: null, toId: null });

    const params = new URLSearchParams(new URL(getTicketLink().getAttribute('href')!).hash.slice(1));
    expect(params.get('soid')).toBe('O=Berlin Hbf');
    expect(params.get('zoid')).toBe('O=München Hbf');
  });

  it('does not render a link when there is no journey snapshot', () => {
    renderTicket({ ...monitor, unavailable: true, journey: null });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not render a link when the route or departure is missing', () => {
    renderTicket({ ...monitor, from: null, to: null });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
