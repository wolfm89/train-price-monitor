import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SearchResult, { Journey } from './SearchResult';
import { AlertSeverity } from '../providers/AlertProvider';
import { AuthContext } from '../providers/AuthProvider';

vi.mock('../utils/auth', () => ({
  getCurrentUser: vi.fn(),
  hasStoredUser: vi.fn(() => false),
  signIn: vi.fn(),
  signOut: vi.fn(),
  getSession: vi.fn(),
  deleteUser: vi.fn(),
}));

const { mockMonitor, mockAddAlert } = vi.hoisted(() => ({
  mockMonitor: vi.fn(),
  mockAddAlert: vi.fn(),
}));

vi.mock('urql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('urql')>();
  return {
    ...actual,
    useMutation: () => [{}, mockMonitor],
  };
});

vi.mock('../hooks/useAlert', () => ({
  default: () => ({ addAlert: mockAddAlert, removeAlert: vi.fn() }),
}));

const authValue = {
  user: { 'custom:id': 'u1', given_name: 'Ada', family_name: 'Lovelace', email: 'ada@example.com' },
  userProfilePictureUrl: undefined,
  isInitialCheckDone: true,
  signIn: vi.fn(),
  signOut: vi.fn(),
  refetchUserProfilePictureUrl: vi.fn(),
  deleteUser: vi.fn(),
};

const journey: Journey = {
  refreshToken: 'token-1',
  fromId: '8000105',
  toId: '8000261',
  departure: '2030-01-15T09:00:00.000Z',
  arrival: '2030-01-15T13:00:00.000Z',
  means: ['ICE'],
  price: 42,
};

const secondJourney: Journey = {
  refreshToken: 'token-2',
  fromId: '8000261',
  toId: '8000105',
  departure: '2030-01-15T10:00:00.000Z',
  arrival: '2030-01-15T14:00:00.000Z',
  means: ['RE'],
  price: 50,
};

function renderResult(journeys: Journey[] = [journey]): void {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue as never}>
        <SearchResult searchResult={journeys} />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

const WATCH_NAME = /Add the .* connection to your watchlist/;

function startWatch(index = 0): void {
  fireEvent.click(screen.getAllByRole('button', { name: WATCH_NAME })[index]);
  fireEvent.change(screen.getByRole('textbox', { name: 'Limit price' }), { target: { value: '80' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
}

describe('SearchResult watch action', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('links to the new watchlist entry, focuses it, and announces success', async () => {
    mockMonitor.mockResolvedValue({ data: { monitorJourney: { id: 'jm-1' } } });

    renderResult();
    startWatch();

    const link = await screen.findByRole('link', { name: /connection in your watchlist/i });
    expect(link).toHaveAttribute('href', '/journeys#jm-1');
    expect(link.getAttribute('aria-label')).toMatch(/10:00.*14:00.*ICE.*connection in your watchlist/);
    expect(screen.queryByRole('button', { name: WATCH_NAME })).not.toBeInTheDocument();

    expect(mockMonitor).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        refreshToken: 'token-1',
        limitPrice: 80,
        fromId: '8000105',
        toId: '8000261',
      })
    );
    expect(mockAddAlert).toHaveBeenCalledTimes(1);
    expect(mockAddAlert).toHaveBeenCalledWith('Journey successfully added to watchlist!', AlertSeverity.Success);

    // The replaced button is unmounted; focus must follow the new link.
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  it('keeps the watch button and reports an error when the mutation fails', async () => {
    mockMonitor.mockResolvedValue({ error: { message: 'Nope' } });

    renderResult();
    startWatch();

    await waitFor(() => expect(mockAddAlert).toHaveBeenCalledWith('Nope', AlertSeverity.Error));
    expect(mockAddAlert).not.toHaveBeenCalledWith(expect.stringContaining('successfully'), AlertSeverity.Success);
    const watch = await screen.findByRole('button', { name: WATCH_NAME });
    expect(watch).toBeInTheDocument();
    await waitFor(() => expect(watch).toHaveFocus());
    expect(screen.queryByRole('link', { name: /watchlist/i })).not.toBeInTheDocument();
  });

  it('treats a success response without an id as a failure', async () => {
    mockMonitor.mockResolvedValue({ data: { monitorJourney: {} } });

    renderResult();
    startWatch();

    await waitFor(() =>
      expect(mockAddAlert).toHaveBeenCalledWith(
        'Failed to add journey to watchlist. Please try again.',
        AlertSeverity.Error
      )
    );
    expect(await screen.findByRole('button', { name: WATCH_NAME })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /watchlist/i })).not.toBeInTheDocument();
  });

  it('explains the limit rule instead of submitting an empty amount', () => {
    renderResult();
    fireEvent.click(screen.getByRole('button', { name: WATCH_NAME }));
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));

    expect(mockMonitor).not.toHaveBeenCalled();
    const input = screen.getByRole('textbox', { name: 'Limit price' });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'limit-price-helper-text');
    expect(screen.getByText(/Enter an amount above €42/)).toBeInTheDocument();
  });

  it('accepts a comma decimal and rejects an amount at or below the current fare', async () => {
    mockMonitor.mockResolvedValue({ data: { monitorJourney: { id: 'jm-2' } } });

    renderResult();
    fireEvent.click(screen.getByRole('button', { name: WATCH_NAME }));
    const input = screen.getByRole('textbox', { name: 'Limit price' });

    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(mockMonitor).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '42,50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(mockMonitor).toHaveBeenCalledWith(expect.objectContaining({ limitPrice: 42.5 })));
  });

  it('submits with Enter once the amount is valid', async () => {
    mockMonitor.mockResolvedValue({ data: { monitorJourney: { id: 'jm-3' } } });

    renderResult();
    fireEvent.click(screen.getByRole('button', { name: WATCH_NAME }));
    const input = screen.getByRole('textbox', { name: 'Limit price' });
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockMonitor).toHaveBeenCalledWith(expect.objectContaining({ limitPrice: 80 })));
  });

  it('announces progress without removing the row action while pending', async () => {
    let resolveMonitor!: (value: unknown) => void;
    mockMonitor.mockReturnValue(
      new Promise((resolve) => {
        resolveMonitor = resolve;
      })
    );

    renderResult();
    fireEvent.click(screen.getByRole('button', { name: WATCH_NAME }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Limit price' }), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));

    const pending = await screen.findByRole('button', { name: /Adding the 10:00 connection to your watchlist/ });
    expect(pending).toHaveAttribute('aria-busy', 'true');
    expect(pending).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    resolveMonitor({ data: { monitorJourney: { id: 'jm-4' } } });
    await waitFor(() => expect(screen.getByRole('link', { name: /watchlist/ })).toBeInTheDocument());
  });

  it('only turns the watched row into a link', async () => {
    mockMonitor.mockResolvedValue({ data: { monitorJourney: { id: 'jm-1' } } });

    renderResult([journey, secondJourney]);
    startWatch(0);

    const links = await screen.findAllByRole('link', { name: /watchlist/i });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/journeys#jm-1');
    expect(screen.getAllByRole('button', { name: WATCH_NAME })).toHaveLength(1);
  });
});
