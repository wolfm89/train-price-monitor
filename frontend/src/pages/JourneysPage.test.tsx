import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import JourneysPage from './JourneysPage';
import { AuthContext } from '../providers/AuthProvider';

vi.mock('../utils/auth', () => ({
  getCurrentUser: vi.fn(),
  hasStoredUser: vi.fn(() => false),
  signIn: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
}));

const { mockDelete, mockReexecute, mockAddAlert, journey } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
  mockReexecute: vi.fn(),
  mockAddAlert: vi.fn(),
  journey: {
    id: 'j1',
    limitPrice: 50,
    unavailable: false,
    from: 'Berlin Hbf',
    to: 'München Hbf',
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
  },
}));

vi.mock('urql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('urql')>();
  return {
    ...actual,
    useQuery: () => [
      { data: { user: { journeyMonitors: [journey] } }, fetching: false, error: undefined },
      mockReexecute,
    ],
    useMutation: () => [{}, mockDelete],
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

describe('JourneysPage deletion', () => {
  it('asks for confirmation before deleting a journey', async () => {
    mockDelete.mockResolvedValue({ error: undefined });
    render(
      <MemoryRouter>
        <AuthContext.Provider value={authValue as never}>
          <JourneysPage />
        </AuthContext.Provider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'more options' }));
    fireEvent.click(screen.getByText('Remove from watchlist'));

    expect(screen.getByText('Remove journey?')).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Remove journey?')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'more options' }));
    fireEvent.click(screen.getByText('Remove from watchlist'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith({ userId: 'u1', journeyId: 'j1' }));
    await waitFor(() => expect(mockAddAlert).toHaveBeenCalled());
  });
});
