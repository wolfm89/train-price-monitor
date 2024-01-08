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
  journeyMonitor: {
    id: string;
    journey: {
      from: string;
      to: string;
    };
  };
}

interface NotificationPopoverProps {
  anchorEl: any;
  id: string | undefined;
  open: boolean;
  onClose: () => void;
  notifications: any;
  onMarkAsRead: (notificationId: string) => void;
  handleNotificationClicked: (notification: Notification) => void;
}

const formatNotification = (notification: any) => {
  switch (notification.type) {
    case 'PRICE_ALERT':
      return `Price limit reached for journey from ${notification.journeyMonitor.journey.from} to ${notification.journeyMonitor.journey.to}`;
    case 'JOURNEY_EXPIRED':
      return `Watched journey from ${notification.journey.from} to ${notification.journey.to} expired`;
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
