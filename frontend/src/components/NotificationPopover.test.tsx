import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotificationPopover, { Notification } from './NotificationPopover';

const anchor = document.createElement('button');
document.body.appendChild(anchor);

afterEach(() => {
  vi.clearAllMocks();
});

const priceAlert: Notification = {
  id: 'n1',
  type: 'PRICE_ALERT',
  read: false,
  timestamp: new Date('2026-11-13T10:00:00Z'),
  journeyMonitor: { id: 'j1', from: 'Berlin', to: 'München' },
};

function renderPopover(notifications: Notification[], onMarkAsRead = vi.fn(), onClose = vi.fn()) {
  return render(
    <MemoryRouter>
      <NotificationPopover
        anchorEl={anchor}
        id="notification-popover"
        open
        onClose={onClose}
        notifications={notifications}
        onMarkAsRead={onMarkAsRead}
      />
    </MemoryRouter>
  );
}

describe('NotificationPopover', () => {
  it('exposes a named dialog with link rows and a separate mark-as-read action', () => {
    const onMarkAsRead = vi.fn();
    renderPopover([priceAlert], onMarkAsRead);

    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /Unread.*Price limit reached for Berlin → München/ });
    expect(link).toHaveAttribute('href', '/journeys#j1');

    const markButton = screen.getByRole('button', {
      name: 'Mark notification as read: Price limit reached for Berlin → München',
    });
    expect(link.contains(markButton)).toBe(false);

    fireEvent.click(markButton);
    expect(onMarkAsRead).toHaveBeenCalledWith('n1');
  });

  it('renders a fallback for unknown notification types without a dead blank row', () => {
    renderPopover([{ ...priceAlert, id: 'n2', type: 'FUTURE_TYPE' }]);

    expect(screen.getByText('You have a new notification')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not show a mark-as-read action for read notifications', () => {
    renderPopover([{ ...priceAlert, read: true }]);

    expect(screen.queryByRole('button', { name: /Mark notification as read/ })).not.toBeInTheDocument();
  });

  it('keeps the notification list scrollable inside the viewport', () => {
    renderPopover([priceAlert]);

    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(dialog).toHaveStyle({ maxHeight: 'min(70vh, 520px)', display: 'flex' });
    expect(dialog).toHaveStyle({ overflow: 'hidden' });
  });
});
