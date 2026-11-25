import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LoginModal from './LoginModal';
import { AuthContext } from '../providers/AuthProvider';

vi.mock('../utils/auth', () => ({
  getCurrentUser: vi.fn(),
  hasStoredUser: vi.fn(() => false),
  signIn: vi.fn(),
  signOut: vi.fn(),
  getSession: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock('../hooks/useAlert', () => ({
  default: () => ({ addAlert: vi.fn(), removeAlert: vi.fn() }),
}));

const signIn = vi.fn();
const authValue = { signIn } as never;

beforeEach(() => {
  signIn.mockReset();
});

function renderModal() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <LoginModal open onClose={vi.fn()} />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('LoginModal validation', () => {
  it('shows field-level errors and clears them as values are entered', () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } });
    expect(screen.queryByText('Enter your email address.')).not.toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'correct-horse' } });
    expect(screen.queryByText('Enter your password.')).not.toBeInTheDocument();
  });

  it('surfaces a rejected sign-in as a form error and focuses the password', async () => {
    signIn.mockRejectedValueOnce(new Error('Incorrect username or password.'));
    renderModal();

    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(screen.getByText('Incorrect username or password.')).toBeInTheDocument());
    expect(screen.getByLabelText(/Password/)).toHaveFocus();
  });

  it('submits the credentials once both fields are present', async () => {
    signIn.mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <AuthContext.Provider value={{ signIn } as never}>
          <LoginModal open onClose={onClose} />
        </AuthContext.Provider>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(signIn).toHaveBeenCalledWith('ada@example.com', 'correct-horse'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
