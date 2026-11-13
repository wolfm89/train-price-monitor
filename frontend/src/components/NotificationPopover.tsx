import React from 'react';
import { Link } from 'react-router-dom';
import { Popover, Box, Typography, IconButton, Chip, ButtonBase } from '@mui/material';
import { formatTime } from '../utils/format';
import { CheckCircle as CheckCircleIcon } from '@mui/icons-material';
import VisuallyHidden from './VisuallyHidden';

export interface Notification {
  id: string;
  type: string;
  read: boolean;
  timestamp: Date;
  from?: string;
  to?: string;
  journeyId?: string;
  journeyMonitor?: {
    id: string;
    from: string;
    to: string;
  };
}

interface NotificationPopoverProps {
  anchorEl: HTMLButtonElement | null;
  id: string | undefined;
  open: boolean;
  onClose: () => void;
  notifications: Notification[];
  onMarkAsRead: (notificationId: string) => void;
}

function formatRelativeTime(timestamp: Date): string {
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays === 1) {
    return `Yesterday, ${formatTime(date)}`;
  }
  return `${diffDays} days ago`;
}

function notificationPlainText(notification: Notification): string {
  switch (notification.type) {
    case 'PRICE_ALERT':
      return notification.journeyMonitor
        ? `Price limit reached for ${notification.journeyMonitor.from} → ${notification.journeyMonitor.to}`
        : 'Price limit reached for a watched journey';
    case 'JOURNEY_EXPIRED':
      return notification.from && notification.to
        ? `Journey ${notification.from} → ${notification.to} has expired`
        : 'A watched journey has expired';
    case 'JOURNEY_STALE':
      return notification.from && notification.to
        ? `Journey ${notification.from} → ${notification.to} can no longer be tracked`
        : 'A watched journey can no longer be tracked';
    default:
      return 'You have a new notification';
  }
}

function notificationHref(notification: Notification): string | null {
  switch (notification.type) {
    case 'PRICE_ALERT':
      return notification.journeyMonitor?.id ? `/journeys#${notification.journeyMonitor.id}` : '/journeys';
    case 'JOURNEY_EXPIRED':
      return '/journeys';
    case 'JOURNEY_STALE':
      return notification.journeyId ? `/journeys#${notification.journeyId}` : '/journeys';
    default:
      return null;
  }
}

function formatNotificationText(notification: Notification): React.ReactNode {
  switch (notification.type) {
    case 'PRICE_ALERT':
      return (
        <>
          Price limit reached for{' '}
          {notification.journeyMonitor ? (
            <strong>
              {notification.journeyMonitor.from} → {notification.journeyMonitor.to}
            </strong>
          ) : (
            'a watched journey'
          )}
        </>
      );
    case 'JOURNEY_EXPIRED':
      return notification.from && notification.to ? (
        <>
          Journey{' '}
          <strong>
            {notification.from} → {notification.to}
          </strong>{' '}
          has expired
        </>
      ) : (
        'A watched journey has expired'
      );
    case 'JOURNEY_STALE':
      return notification.from && notification.to ? (
        <>
          Journey{' '}
          <strong>
            {notification.from} → {notification.to}
          </strong>{' '}
          can no longer be tracked
        </>
      ) : (
        'A watched journey can no longer be tracked'
      );
    default:
      return notificationPlainText(notification);
  }
}

const NotificationPopover: React.FC<NotificationPopoverProps> = ({
  anchorEl,
  id,
  open,
  onClose,
  notifications,
  onMarkAsRead,
}) => {
  const unreadCount = notifications?.filter((n) => !n.read).length ?? 0;

  return (
    <Popover
      id={id}
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{
        paper: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'notifications-heading',
          sx: {
            minWidth: 300,
            maxWidth: 340,
            maxHeight: 'min(70vh, 520px)',
            borderRadius: 2,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 2,
          py: 1.25,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <Typography
          id="notifications-heading"
          component="h2"
          sx={{
            m: 0,
            fontSize: 11,
            fontWeight: 700,
            color: 'text.secondary',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
          }}
        >
          Notifications
        </Typography>
        {unreadCount > 0 && (
          <Chip
            label={unreadCount}
            aria-label={`${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`}
            size="small"
            sx={{
              bgcolor: 'primary.main',
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              height: 18,
              minWidth: 18,
            }}
          />
        )}
      </Box>

      {/* Notification items */}
      <Box sx={{ overflowY: 'auto', flex: 1 }}>
        {notifications && notifications.length > 0 ? (
          <Box role="list">
            {notifications.map((notification: Notification) => {
              const href = notificationHref(notification);
              const content = (
                <>
                  {/* Unread dot */}
                  <Box
                    aria-hidden="true"
                    sx={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      bgcolor: notification.read ? 'divider' : 'primary.main',
                      flexShrink: 0,
                      mt: '5px',
                    }}
                  />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 12, color: 'text.primary', lineHeight: 1.5, mb: 0.25 }}>
                      {!notification.read && <VisuallyHidden>Unread. </VisuallyHidden>}
                      {formatNotificationText(notification)}
                    </Typography>
                    <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                      {formatRelativeTime(notification.timestamp)}
                    </Typography>
                  </Box>
                </>
              );

              return (
                <Box
                  key={notification.id}
                  role="listitem"
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    borderBottom: 1,
                    borderColor: 'divider',
                    '&:last-child': { borderBottom: 0 },
                  }}
                >
                  {href ? (
                    <ButtonBase
                      component={Link}
                      to={href}
                      onClick={onClose}
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'flex-start',
                        gap: 1.25,
                        px: 2,
                        py: 1.25,
                        textAlign: 'left',
                        transition: 'background 0.12s',
                        '&:hover': { bgcolor: 'background.default' },
                      }}
                    >
                      {content}
                    </ButtonBase>
                  ) : (
                    <Box
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 1.25,
                        px: 2,
                        py: 1.25,
                      }}
                    >
                      {content}
                    </Box>
                  )}

                  {/* Mark as read */}
                  {!notification.read && (
                    <IconButton
                      aria-label={`Mark notification as read: ${notificationPlainText(notification)}`}
                      size="small"
                      onClick={() => onMarkAsRead(notification.id)}
                      sx={{
                        color: 'text.disabled',
                        mt: 0.75,
                        mr: 1,
                        flexShrink: 0,
                        '&:hover': { color: 'secondary.dark' },
                      }}
                    >
                      <CheckCircleIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  )}
                </Box>
              );
            })}
          </Box>
        ) : (
          <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
            <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>No notifications</Typography>
          </Box>
        )}
      </Box>
    </Popover>
  );
};

export default NotificationPopover;
