import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import SearchPage from './SearchPage';
import { AuthContext } from '../providers/AuthProvider';
import { UserTravelPreferencesQuery } from '../api/user';
import { JourneySearchQuery } from '../api/journey';
import { toSearchParams } from '../utils/searchQueryVars';

vi.mock('../utils/auth', () => ({
  getCurrentUser: vi.fn(),
  hasStoredUser: vi.fn(() => false),
  signIn: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
}));

const { mockReexecute } = vi.hoisted(() => ({ mockReexecute: vi.fn() }));

vi.mock('urql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('urql')>();
  return {
    ...actual,
    useQuery: (options: { query: unknown }) => {
      if (options.query === UserTravelPreferencesQuery) {
        return [{ data: { user: null }, fetching: false }, vi.fn()];
      }
      if (options.query === JourneySearchQuery) {
        return [
          {
            data: { journeys: { journeys: [], earlierRef: null, laterRef: null } },
            fetching: false,
          },
          vi.fn(),
        ];
      }
      return [{ data: undefined, fetching: false }, mockReexecute];
    },
  };
});

const authValue = {
  user: { 'custom:id': 'u1', given_name: 'Ada', family_name: 'Lovelace', email: 'ada@example.com' },
  userProfilePictureUrl: undefined,
  isInitialCheckDone: true,
  signIn: vi.fn(),
  signOut: vi.fn(),
  refetchUserProfilePictureUrl: vi.fn(),
  deleteUser: vi.fn(),
};

describe('SearchPage URL state', () => {
  it('hydrates the search form from a deep link', () => {
    const params = toSearchParams({
      from: '8000105',
      to: '8000261',
      departure: '2030-01-15T09:00:00.000Z',
      fromName: 'Berlin Hbf',
      toName: 'München Hbf',
    });

    render(
      <MemoryRouter initialEntries={[`/search?${params.toString()}`]}>
        <AuthContext.Provider value={authValue as never}>
          <Routes>
            <Route path="/search" element={<SearchPage />} />
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>
    );

    expect(screen.getByRole('combobox', { name: 'From station' })).toHaveValue('Berlin Hbf');
    expect(screen.getByRole('combobox', { name: 'To station' })).toHaveValue('München Hbf');
  });
});
