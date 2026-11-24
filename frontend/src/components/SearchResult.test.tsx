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

  it('keeps the dialog and amount when the mutation fails', async () => {
    mockMonitor.mockResolvedValue({ error: { message: 'Nope' } });

    renderResult();
    startWatch();

    await waitFor(() => expect(screen.getByText('Could not save the limit. Please try again.')).toBeInTheDocument());
    expect(mockAddAlert).not.toHaveBeenCalledWith(expect.stringContaining('successfully'), AlertSeverity.Success);
    const input = screen.getByRole('textbox', { name: 'Limit price' });
    expect(input).toHaveValue('80');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('link', { name: /watchlist/i })).not.toBeInTheDocument();
  });

  it('treats a success response without an id as a failure', async () => {
    mockMonitor.mockResolvedValue({ data: { monitorJourney: {} } });

    renderResult();
    startWatch();

    await waitFor(() => expect(screen.getByText('Could not save the limit. Please try again.')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Limit price' })).toHaveValue('80');
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
    expect(screen.getByText(/Your limit must be above the current fare of €42/, { selector: 'p' })).toBeInTheDocument();
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

  it('validates live while the field is still focused', async () => {
    renderResult();
    fireEvent.click(screen.getByRole('button', { name: WATCH_NAME }));
    const input = screen.getByRole('textbox', { name: 'Limit price' });
    input.focus();

    fireEvent.change(input, { target: { value: '10' } });
    await waitFor(() =>
      expect(
        screen.getByText(/Your limit must be above the current fare of €42/, { selector: 'p' })
      ).toBeInTheDocument()
    );
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: '80' } });
    await waitFor(() =>
      expect(
        screen.queryByText(/Your limit must be above the current fare of €42/, { selector: 'p' })
      ).not.toBeInTheDocument()
    );
    expect(input).toHaveFocus();
  });

  it('only permits one positive decimal amount', async () => {
    renderResult();
    fireEvent.click(screen.getByRole('button', { name: WATCH_NAME }));
    const input = screen.getByRole('textbox', { name: 'Limit price' });

    fireEvent.change(input, { target: { value: 'abc1a2.345xyz' } });
    expect(input).toHaveValue('12345');

    fireEvent.change(input, { target: { value: '12.34.56' } });
    expect(input).toHaveValue('12.34');

    fireEvent.change(input, { target: { value: '1.234,56' } });
    expect(input).toHaveValue('1234,56');

    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input).toHaveValue('');

    fireEvent.change(input, { target: { value: '８０．５' } });
    expect(input).toHaveValue('80.5');

    fireEvent.change(input, { target: { value: '1234567890123' } });
    expect(input).toHaveValue('123456789');

    fireEvent.paste(input, { clipboardData: { getData: () => '1.234,56' } });
    expect(input).toHaveValue('1234,56');

    fireEvent.change(input, { target: { value: '42.' } });
    expect(input).toHaveValue('42.');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.queryByText(/Your limit must be above/)).not.toBeInTheDocument();
  });

  it('lets the user type a grouped amount without being blocked at two decimals', () => {
    renderResult();
    fireEvent.click(screen.getByRole('button', { name: WATCH_NAME }));
    const input = screen.getByRole('textbox', { name: 'Limit price' });

    for (const value of ['1', '1.', '1.2', '1.23', '1.234', '1234,', '1234,5', '1234,56']) {
      fireEvent.change(input, { target: { value } });
    }

    expect(input).toHaveValue('1234,56');
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

  it('shows a saving state in the dialog while pending', async () => {
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

    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    expect(saving).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('textbox', { name: 'Limit price' })).toHaveValue('80');
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
