import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';
import { AuthContext } from '../providers/AuthProvider';
import { changePassword } from '../utils/auth';

vi.mock('../utils/auth', () => ({
  getCurrentUser: vi.fn(),
  hasStoredUser: vi.fn(() => false),
  signIn: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
  changePassword: vi.fn(),
}));

vi.mock('../components/TravelPreferences', () => ({
  default: () => <div data-testid="travel-preferences" />,
}));

vi.mock('../hooks/useUnsavedChangesWarning', () => ({
  default: () => ({ blocked: false, proceed: vi.fn(), reset: vi.fn() }),
}));

const { mockAddAlert, userSettingsData } = vi.hoisted(() => ({
  mockAddAlert: vi.fn(),
  userSettingsData: { user: { emailNotificationsEnabled: false } },
}));

vi.mock('../hooks/useAlert', () => ({
  default: () => ({ addAlert: mockAddAlert, removeAlert: vi.fn() }),
}));

vi.mock('urql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('urql')>();
  return {
    ...actual,
    useQuery: () => [{ data: userSettingsData, fetching: false }, vi.fn()],
    useMutation: () => [{}, vi.fn()],
    useClient: () => ({ query: vi.fn() }),
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

function renderProfile() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue as never}>
        <ProfilePage />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('ProfilePage', () => {
  it('labels the picture control and settings fields', () => {
    renderProfile();

    expect(screen.getByRole('button', { name: 'Change picture' })).toBeEnabled();
    expect(screen.getByLabelText('First name')).toBeDisabled();
    expect(screen.getByRole('switch', { name: /email alerts/i })).toBeInTheDocument();
    expect(screen.getByTestId('travel-preferences')).toBeInTheDocument();
  });

  it('opens the file picker from the Change picture button', () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    renderProfile();

    fireEvent.click(screen.getByRole('button', { name: 'Change picture' }));

    expect(clickSpy).toHaveBeenCalledOnce();
    clickSpy.mockRestore();
  });

  it('shows a password mismatch inline instead of calling the API', () => {
    renderProfile();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-password' } });
    fireEvent.change(screen.getByLabelText('New password', { exact: true }), { target: { value: 'new-password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    expect(screen.getByText('New passwords do not match.')).toBeInTheDocument();
    expect(vi.mocked(changePassword)).not.toHaveBeenCalled();
  });
});
