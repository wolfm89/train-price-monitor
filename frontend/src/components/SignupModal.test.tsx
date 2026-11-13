import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SignupModal from './SignupModal';

vi.mock('../utils/auth', () => ({
  signUp: vi.fn(),
}));

vi.mock('../hooks/useAlert', () => ({
  default: () => ({ addAlert: vi.fn(), removeAlert: vi.fn() }),
}));

describe('SignupModal validation', () => {
  it('clears field errors as soon as the values become valid', async () => {
    render(<SignupModal open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));

    expect(screen.getByText('Enter your first name.')).toBeInTheDocument();
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: 'Ada' } });
    expect(screen.queryByText('Enter your first name.')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'correct-horse' } });
    fireEvent.change(screen.getByLabelText(/Confirm password/), { target: { value: 'correct-horse' } });

    await waitFor(() => {
      expect(screen.queryByText('Enter your email address.')).not.toBeInTheDocument();
      expect(screen.queryByText('Choose a password.')).not.toBeInTheDocument();
      expect(screen.queryByText('Confirm your password.')).not.toBeInTheDocument();
    });
  });

  it('shows a mismatch immediately after the first submit attempt', async () => {
    render(<SignupModal open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'correct-horse' } });
    fireEvent.change(screen.getByLabelText(/Confirm password/), { target: { value: 'battery-staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Confirm password/), { target: { value: 'correct-horse' } });
    await waitFor(() => expect(screen.queryByText('Passwords do not match.')).not.toBeInTheDocument());
  });
});
