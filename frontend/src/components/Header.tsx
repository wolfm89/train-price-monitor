import React, { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Badge,
  Container,
  useMediaQuery,
  useTheme,
  Avatar,
} from '@mui/material';
import {
  Search as SearchIcon,
  AccountCircle as AccountCircleIcon,
  Notifications as NotificationsIcon,
  Train as TrainIcon,
} from '@mui/icons-material';
import NotificationPopover from './NotificationPopover';
import AccountMenu from './AccountMenu';
import { AuthContext } from '../providers/AuthProvider';
import { UserNotificationsQuery } from '../api/user';
import { useQuery } from 'urql';

const Header = () => {
  const theme = useTheme();
  const isScreenSmall = useMediaQuery(theme.breakpoints.down('sm'));
  const { user, userProfilePictureUrl } = useContext(AuthContext);
  const [userNotificationsResult, reexecuteUserNotificationsQuery] = useQuery({
    query: UserNotificationsQuery,
    variables: { id: user?.['custom:id'], notificationsLimit: 8 },
    pause: !user,
  });

  const [notificationAnchorEl, setNotificationAnchorEl] = useState<HTMLButtonElement | null>(null);

  const handleNotificationClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setNotificationAnchorEl(event.currentTarget);
  };

  const handleNotificationClose = () => {
    setNotificationAnchorEl(null);
  };

  const open = Boolean(notificationAnchorEl);
  const id = open ? 'notification-popover' : undefined;

  const [accountAnchorEl, setAccountAnchorEl] = useState<HTMLButtonElement | null>(null);

  const handleAccountClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAccountAnchorEl(event.currentTarget);
  };

  const handleAccountClose = () => {
    setAccountAnchorEl(null);
  };

  // Schedule the notification query to run every 30 seconds
  useEffect(() => {
    const intervalId = setInterval(() => {
      reexecuteUserNotificationsQuery({ requestPolicy: 'network-only' });
    }, 30000);

    // Clean up the interval when the component is unmounted
    return () => clearInterval(intervalId);
  }, [reexecuteUserNotificationsQuery]);

  return (
    <AppBar position="static" sx={{ maxWidth: 'lg', mx: 'auto' }}>
      <Container maxWidth="xl">
        <Toolbar disableGutters sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Link
            to="/"
            style={{
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              color: 'inherit',
              marginLeft: -5,
            }}
          >
            <img
              src={process.env.PUBLIC_URL + '/logo192.png'}
              alt="Train Price Monitor Logo"
              style={{ width: 50, height: 50, marginRight: 2 }}
            />
            {!isScreenSmall && (
              <Typography variant="h6" component="div" sx={{ marginLeft: 1, color: 'inherit', whiteSpace: 'nowrap' }}>
                Train Price Monitor
              </Typography>
            )}
          </Link>
          {user && (
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <Link
                to="/search"
                style={{
                  textDecoration: 'none',
                  color: 'inherit',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <IconButton color="inherit" sx={{ borderRadius: 4 }}>
                  <SearchIcon />
                  {!isScreenSmall && (
                    <Typography
                      variant="subtitle1"
                      component="div"
                      sx={{
                        marginLeft: 1,
                        xs: 'none',
                        md: 'block',
                        color: 'inherit',
                      }}
                    >
                      Search
                    </Typography>
                  )}
                </IconButton>
              </Link>
              <Link
                to="/journeys"
                style={{
                  textDecoration: 'none',
                  color: 'inherit',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <IconButton color="inherit" sx={{ borderRadius: 4 }}>
                  <TrainIcon />
                  {!isScreenSmall && (
                    <Typography
                      variant="subtitle1"
                      component="div"
                      sx={{
                        marginLeft: 1,
                        xs: 'none',
                        md: 'block',
                        color: 'inherit',
                      }}
                    >
                      My Journeys
                    </Typography>
                  )}
                </IconButton>
              </Link>
              <IconButton color="inherit" onClick={handleNotificationClick}>
                <Badge badgeContent={userNotificationsResult.data?.user?.notifications?.length} color="error">
                  <NotificationsIcon />
                </Badge>
              </IconButton>
              <IconButton aria-label="user profile" color="inherit" onClick={handleAccountClick}>
                {userProfilePictureUrl && (
                  <Avatar alt="Profile Picture" src={userProfilePictureUrl} sx={{ width: 24, height: 24 }} />
                )}
                {!userProfilePictureUrl && <AccountCircleIcon />}
              </IconButton>
            </div>
          )}
        </Toolbar>
      </Container>
      <NotificationPopover
        anchorEl={notificationAnchorEl}
        id={id}
        open={open}
        onClose={handleNotificationClose}
        notifications={userNotificationsResult.data?.user?.notifications}
      />
      <AccountMenu anchorEl={accountAnchorEl} onClose={handleAccountClose} />
    </AppBar>
  );
};

export default Header;
