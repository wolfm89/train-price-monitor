import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TravelPreferences from './TravelPreferences';
import { AuthContext } from '../providers/AuthProvider';

vi.mock('../utils/auth', () => ({
  getCurrentUser: vi.fn(),
  hasStoredUser: vi.fn(() => false),
  signIn: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
}));

const { mockUpdate, mockAddAlert, preferences } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockAddAlert: vi.fn(),
  preferences: { user: { loyaltyCards: null, ageGroup: 'ADULT', deutschlandTicketDiscount: false } },
}));

vi.mock('urql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('urql')>();
  return {
    ...actual,
    useQuery: () => [{ data: preferences, fetching: false, error: undefined }, vi.fn()],
    useMutation: () => [{}, mockUpdate],
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

describe('TravelPreferences dirty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports clean again after a successful save', async () => {
    mockUpdate.mockResolvedValue({ error: undefined });
    const onDirtyChange = vi.fn();

    render(
      <AuthContext.Provider value={authValue as never}>
        <TravelPreferences onDirtyChange={onDirtyChange} />
      </AuthContext.Provider>
    );

    fireEvent.click(screen.getByRole('switch'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('reports clean when a discount card is added and removed without saving', async () => {
    const onDirtyChange = vi.fn();

    render(
      <AuthContext.Provider value={authValue as never}>
        <TravelPreferences onDirtyChange={onDirtyChange} />
      </AuthContext.Provider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add discount card' }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole('button', { name: /Remove Bahncard 25/ }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
