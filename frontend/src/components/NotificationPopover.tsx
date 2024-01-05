import React from 'react';
import { Popover, List, ListItemIcon, ListItemText, ListItemButton } from '@mui/material';
import { NotificationImportant as NotificationImportantIcon } from '@mui/icons-material';

interface NotificationPopoverProps {
  anchorEl: any;
  id: string | undefined;
  open: boolean;
  onClose: () => void;
  notifications: any;
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

const NotificationPopover: React.FC<NotificationPopoverProps> = ({ anchorEl, id, open, onClose, notifications }) => {
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
          notifications.map((notification: any, index: number) => (
            <ListItemButton key={index}>
              <ListItemIcon>
                <NotificationImportantIcon />
              </ListItemIcon>
              <ListItemText primary={formatNotification(notification)} />
            </ListItemButton>
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
