import React from 'react';
import { Popover, List, ListItemIcon, ListItemText, ListItemButton } from '@mui/material';
import { NotificationImportant as NotificationImportantIcon } from '@mui/icons-material';

interface NotificationPopoverProps {
  anchorEl: any;
  id: string | undefined;
  open: boolean;
  onClose: () => void;
}

const NotificationPopover: React.FC<NotificationPopoverProps> = ({ anchorEl, id, open, onClose }) => {
  // dummy notifications
  const notifications = ['Notification 1', 'Notification 2', 'Notification 3', 'Notification 4'];
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
        {notifications.map((result: any, index: number) => (
          <ListItemButton>
            <ListItemIcon>
              <NotificationImportantIcon />
            </ListItemIcon>
            <ListItemText primary={result} />
          </ListItemButton>
        ))}
      </List>
    </Popover>
  );
};

export default NotificationPopover;
