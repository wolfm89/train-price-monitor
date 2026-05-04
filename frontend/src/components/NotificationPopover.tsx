import React from 'react';
import { Popover, List, ListItemIcon, ListItemText, ListItemButton, IconButton, Box } from '@mui/material';
import {
  NotificationImportant as NotificationImportantIcon,
  CheckCircle as CheckCircleIcon,
} from '@mui/icons-material';

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

const formatNotification = (notification: Notification) => {
  switch (notification.type) {
    case 'PRICE_ALERT':
      return `Price limit reached for journey from ${notification.journeyMonitor?.from} to ${notification.journeyMonitor?.to}`;
    case 'JOURNEY_EXPIRED':
      return notification.from && notification.to
        ? `Watched journey from ${notification.from} to ${notification.to} expired`
        : 'A watched journey has expired';
    case 'JOURNEY_STALE':
      return notification.from && notification.to
        ? `Journey from ${notification.from} to ${notification.to} can no longer be tracked`
        : 'A watched journey can no longer be tracked';
    default:
      return '';
  }
};

const NotificationPopover: React.FC<NotificationPopoverProps> = ({
  anchorEl,
  id,
  open,
  onClose,
  notifications,
  onMarkAsRead,
  handleNotificationClicked,
}) => {
  return (
    <Popover
      id={id}
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{
        vertical: 'bottom',
        horizontal: 'right',
      }}
      transformOrigin={{
        vertical: 'top',
        horizontal: 'right',
      }}
    >
      <List>
        {notifications && notifications.length > 0 ? (
          notifications.map((notification: Notification, index: number) => (
            <Box display="flex" alignItems="center" key={index}>
              <ListItemButton onClick={() => handleNotificationClicked(notification)}>
                <ListItemIcon>
                  <NotificationImportantIcon />
                </ListItemIcon>
                <ListItemText primary={formatNotification(notification)} />
              </ListItemButton>
              <IconButton aria-label="mark as read" onClick={() => onMarkAsRead(notification.id)}>
                <CheckCircleIcon />
              </IconButton>
            </Box>
          ))
        ) : (
          <ListItemButton disabled>
            <ListItemText primary="No notifications" />
          </ListItemButton>
        )}
      </List>
    </Popover>
  );
};

export default NotificationPopover;
