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
        {notifications?.map((value: any, index: number) => (
          <ListItemButton key={index}>
            <ListItemIcon>
              <NotificationImportantIcon />
            </ListItemIcon>
            <ListItemText primary={value.message} />
          </ListItemButton>
        ))}
      </List>
    </Popover>
  );
};

export default NotificationPopover;
