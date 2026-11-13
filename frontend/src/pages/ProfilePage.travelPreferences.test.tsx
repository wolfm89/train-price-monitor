import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Link, Route, RouterProvider, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';
import { AuthContext } from '../providers/AuthProvider';
import { UserSettingsQuery, UserTravelPreferencesQuery } from '../api/user';

vi.mock('../utils/auth', () => ({
  getCurrentUser: vi.fn(),
  hasStoredUser: vi.fn(() => false),
  signIn: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
  changePassword: vi.fn(),
}));

vi.mock('../utils/accountDeletion', () => ({
  deleteAccountSafely: vi.fn(),
  hasMutationError: vi.fn(() => false),
}));

const { mockUpdate, mockAddAlert, settings, preferences } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockAddAlert: vi.fn(),
  settings: { user: { emailNotificationsEnabled: false } },
  preferences: { user: { loyaltyCards: null, ageGroup: 'ADULT', deutschlandTicketDiscount: false } },
}));

vi.mock('urql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('urql')>();
  return {
    ...actual,
    useQuery: (options: { query: unknown }) => {
      if (options.query === UserSettingsQuery) return [{ data: settings, fetching: false }, vi.fn()];
      if (options.query === UserTravelPreferencesQuery) return [{ data: preferences, fetching: false }, vi.fn()];
      return [{ data: undefined, fetching: false }, vi.fn()];
    },
    useMutation: () => [{}, mockUpdate],
    useClient: () => ({ query: vi.fn() }),
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

function Layout() {
  return (
    <>
      <Link to="/journeys">My Journeys</Link>
      <Routes>
        <Route path="/" element={<ProfilePage />} />
        <Route path="/journeys" element={<p>Journeys page</p>} />
      </Routes>
    </>
  );
}

describe('ProfilePage travel preferences unsaved guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not block navigation after travel preferences were saved', async () => {
    mockUpdate.mockResolvedValue({ error: undefined });
    const router = createMemoryRouter([{ path: '*', element: <Layout /> }], { initialEntries: ['/'] });

    render(
      <AuthContext.Provider value={authValue as never}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
    );

    fireEvent.click(screen.getByRole('switch', { name: /Deutschlandticket/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    await waitFor(() => expect(mockAddAlert).toHaveBeenCalledWith('Travel preferences saved.', expect.anything()));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save preferences' })).toBeDisabled());

    fireEvent.click(screen.getByText('My Journeys'));

    expect(screen.queryByText('Discard changes?')).not.toBeInTheDocument();
    expect(await screen.findByText('Journeys page')).toBeInTheDocument();
  });

  it('does not block navigation after adding and removing a card without saving', async () => {
    const router = createMemoryRouter([{ path: '*', element: <Layout /> }], { initialEntries: ['/'] });

    render(
      <AuthContext.Provider value={authValue as never}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add discount card' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove Bahncard 25/ }));

    fireEvent.click(screen.getByText('My Journeys'));

    expect(screen.queryByText('Discard changes?')).not.toBeInTheDocument();
    expect(await screen.findByText('Journeys page')).toBeInTheDocument();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
