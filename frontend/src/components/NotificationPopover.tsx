import React from 'react';
import { Popover, Box, Typography, IconButton, Chip, ButtonBase } from '@mui/material';
import { CheckCircle as CheckCircleIcon } from '@mui/icons-material';

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
  handleNotificationClicked: (notification: Notification) => void;
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
    return `Yesterday, ${date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return `${diffDays} days ago`;
}

function formatNotificationText(notification: Notification): React.ReactNode {
  switch (notification.type) {
    case 'PRICE_ALERT':
      return (
        <>
          Price limit reached for{' '}
          <strong>
            {notification.journeyMonitor?.from} → {notification.journeyMonitor?.to}
          </strong>
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
      return '';
  }
}

const NotificationPopover: React.FC<NotificationPopoverProps> = ({
  anchorEl,
  id,
  open,
  onClose,
  notifications,
  onMarkAsRead,
  handleNotificationClicked,
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
          sx: { minWidth: 300, maxWidth: 340, borderRadius: 2, overflow: 'hidden' },
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
        }}
      >
        <Typography
          sx={{
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
      {notifications && notifications.length > 0 ? (
        notifications.map((notification: Notification) => (
          <ButtonBase
            component="div"
            key={notification.id}
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 1.25,
              px: 2,
              py: 1.25,
              borderBottom: 1,
              borderColor: 'divider',
              width: '100%',
              textAlign: 'left',
              transition: 'background 0.12s',
              '&:hover': { bgcolor: 'background.default' },
              '&:last-child': { borderBottom: 0 },
            }}
            onClick={() => handleNotificationClicked(notification)}
          >
            {/* Unread dot */}
            <Box
              sx={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                bgcolor: notification.read ? 'divider' : 'primary.main',
                flexShrink: 0,
                mt: '5px',
              }}
            />

            {/* Body */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: 12, color: 'text.primary', lineHeight: 1.5, mb: 0.25 }}>
                {formatNotificationText(notification)}
              </Typography>
              <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                {formatRelativeTime(notification.timestamp)}
              </Typography>
            </Box>

            {/* Mark as read */}
            {!notification.read && (
              <IconButton
                aria-label="mark as read"
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkAsRead(notification.id);
                }}
                sx={{ color: 'text.disabled', '&:hover': { color: 'secondary.dark' } }}
              >
                <CheckCircleIcon sx={{ fontSize: 16 }} />
              </IconButton>
            )}
          </ButtonBase>
        ))
      ) : (
        <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>No notifications</Typography>
        </Box>
      )}
    </Popover>
  );
};

export default NotificationPopover;
