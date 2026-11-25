import { render, screen, within } from '@testing-library/react';
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

function renderHeader(auth: unknown = authValue) {
  return render(
    <MemoryRouter initialEntries={['/search']}>
      <AuthContext.Provider value={auth as never}>
        <Header />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

function stubMatchMedia(mobile: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: mobile && query.includes('max-width'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
  );
}

beforeEach(() => {
  stubMatchMedia(true);
});

describe('Header', () => {
  it('names the mobile icon controls', () => {
    renderHeader();

    const notificationsButton = screen.getByRole('button', { name: 'Notifications, 1 unread' });
    expect(notificationsButton).toBeInTheDocument();
    expect(notificationsButton).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByRole('link', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My Journeys' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('marks the active route for assistive technology', () => {
    renderHeader();

    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps navigation and utilities in separate groups', () => {
    renderHeader();

    const navigation = screen.getByRole('navigation', { name: 'Main' });
    expect(within(navigation).getByRole('link', { name: 'Search' })).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'My Journeys' })).toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: /Notifications/ })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();

    const notifications = screen.getByRole('button', { name: 'Notifications, 1 unread' });
    const account = screen.getByRole('button', { name: 'Account menu' });
    expect(notifications.parentElement).toBe(account.parentElement);
  });

  it('renders the desktop labels when the viewport is not mobile', () => {
    stubMatchMedia(false);
    renderHeader();

    expect(screen.getByRole('link', { name: 'Search' })).toHaveTextContent('Search');
    expect(screen.getByRole('link', { name: 'My Journeys' })).toHaveTextContent('My Journeys');
  });

  it('renders the logged-out header without navigation or utilities', () => {
    renderHeader({ ...authValue, user: null });

    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
  });
});
