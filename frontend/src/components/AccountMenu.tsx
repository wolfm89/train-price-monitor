import React from 'react';
import { Menu, MenuItem, ListItemIcon, ListItemText } from '@mui/material';
import { AccountCircle as AccountCircleIcon, ExitToApp as ExitToAppIcon } from '@mui/icons-material';
import { Link } from 'react-router-dom';
import { signOut } from '../utils/auth';

interface Props {
  anchorEl: HTMLButtonElement | null;
  onClose: () => void;
}

const AccountMenu: React.FC<Props> = ({ anchorEl, onClose }) => {
  const isMenuOpen = Boolean(anchorEl);

  const handleMenuClose = () => {
    onClose();
  };

  function handleLogout(): void {
    signOut();
    handleMenuClose();
  }

  return (
    <Menu
      anchorEl={anchorEl}
      anchorOrigin={{
        vertical: 'top',
        horizontal: 'right',
      }}
      id="account-menu"
      keepMounted
      transformOrigin={{
        vertical: 'top',
        horizontal: 'right',
      }}
      open={isMenuOpen}
      onClose={handleMenuClose}
    >
      <MenuItem component={Link} to="/profile" onClick={handleMenuClose}>
        <ListItemIcon>
          <AccountCircleIcon />
        </ListItemIcon>
        <ListItemText primary="Profile" />
      </MenuItem>
      <MenuItem onClick={handleLogout}>
        <ListItemIcon>
          <ExitToAppIcon />
        </ListItemIcon>
        <ListItemText primary="Logout" />
      </MenuItem>
    </Menu>
  );
};

export default AccountMenu;
