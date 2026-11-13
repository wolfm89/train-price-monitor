import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AlertBar from './AlertBar';
import { AlertSeverity } from '../providers/AlertProvider';

const { mockAlert } = vi.hoisted(() => ({
  mockAlert: { current: null as { message: string; severity: AlertSeverity } | null },
}));

vi.mock('../hooks/useAlert', () => ({
  default: () => ({ alert: mockAlert.current, removeAlert: vi.fn() }),
}));

vi.mock('../hooks/usePrefersReducedMotion', () => ({
  default: () => false,
}));

describe('AlertBar', () => {
  it('announces success messages politely', () => {
    mockAlert.current = { message: 'Preferences saved.', severity: AlertSeverity.Success };
    render(<AlertBar />);

    expect(screen.getByRole('status')).toHaveTextContent('Preferences saved.');
  });

  it('announces errors assertively', () => {
    mockAlert.current = { message: 'Search failed.', severity: AlertSeverity.Error };
    render(<AlertBar />);

    expect(screen.getByRole('alert')).toHaveTextContent('Search failed.');
  });
});
