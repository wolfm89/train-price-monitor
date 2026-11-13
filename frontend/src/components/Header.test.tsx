import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Header from './Header';
import { AuthContext } from '../providers/AuthProvider';

vi.mock('../utils/auth', () => ({
  getCurrentUser: vi.fn(),
  hasStoredUser: vi.fn(() => false),
  signIn: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
}));

const { mockReexecute, mockNotifications } = vi.hoisted(() => ({
  mockReexecute: vi.fn(),
  mockNotifications: [
    {
      id: 'n1',
      type: 'PRICE_ALERT',
      read: false,
      timestamp: new Date('2026-11-13T10:00:00Z'),
      journeyMonitor: { id: 'j1', from: 'Berlin', to: 'München' },
    },
  ],
}));

vi.mock('urql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('urql')>();
  return {
    ...actual,
    useQuery: () => [
      {
        stale: false,
        data: { user: { notifications: mockNotifications } },
      },
      mockReexecute,
    ],
    useMutation: () => [{}, vi.fn()],
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

function renderHeader() {
  return render(
    <MemoryRouter initialEntries={['/search']}>
      <AuthContext.Provider value={authValue as never}>
        <Header />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
  );
});

describe('Header', () => {
  it('names the mobile icon controls', () => {
    renderHeader();

    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My Journeys' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('marks the active route for assistive technology', () => {
    renderHeader();

    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('aria-current', 'page');
  });
});
