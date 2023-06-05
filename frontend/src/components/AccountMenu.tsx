import React, { useContext } from 'react';
import { Menu, MenuItem, ListItemIcon, ListItemText, Avatar } from '@mui/material';
import { AccountCircle as AccountCircleIcon, ExitToApp as ExitToAppIcon } from '@mui/icons-material';
import { Link } from 'react-router-dom';
import { AuthContext } from '../providers/AuthProvider';

interface Props {
  anchorEl: HTMLButtonElement | null;
  onClose: () => void;
}

const AccountMenu: React.FC<Props> = ({ anchorEl, onClose }) => {
  const isMenuOpen = Boolean(anchorEl);
  const { signOut, userProfilePictureUrl } = useContext(AuthContext);

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
          {userProfilePictureUrl && (
            <Avatar alt="Profile Picture" src={userProfilePictureUrl} sx={{ width: 24, height: 24 }} />
          )}
          {!userProfilePictureUrl && <AccountCircleIcon />}
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
