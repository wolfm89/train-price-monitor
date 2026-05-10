import React, { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Badge,
  useMediaQuery,
  useTheme,
  Avatar,
  Box,
  Button,
} from '@mui/material';
import { Search as SearchIcon, Notifications as NotificationsIcon, Train as TrainIcon } from '@mui/icons-material';
import NotificationPopover, { Notification } from './NotificationPopover';
import AccountMenu from './AccountMenu';
import { AuthContext } from '../providers/AuthProvider';
import { UserNotificationsQuery } from '../api/user';
import { useMutation, useQuery } from 'urql';
import { MarkNotificationAsRead } from '../api/notification';
import { useNavigate } from 'react-router-dom';

const NAV_HEIGHT = 54;

const navBtnSx = {
  color: 'rgba(255,255,255,0.8)',
  fontSize: 14,
  fontWeight: 500,
  borderRadius: '6px',
  px: { xs: 0.75, sm: 1.5 },
  py: 0.75,
  minWidth: 0, // override MUI Button default 64px min-width so icon-only buttons are compact on mobile
  textTransform: 'none' as const,
  '& .MuiButton-startIcon': {
    marginRight: { xs: 0, sm: '8px' }, // collapse icon trailing margin when no text follows on mobile
  },
  '&:hover': {
    backgroundColor: 'rgba(255,255,255,0.13)',
    color: '#fff',
  },
};

const Header = () => {
  const theme = useTheme();
  const navigate = useNavigate();
  const isScreenSmall = useMediaQuery(theme.breakpoints.down('sm'));
  const { user, userProfilePictureUrl } = useContext(AuthContext);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [{ stale, data: userNotificationsResult }, reexecuteUserNotificationsQuery] = useQuery({
    query: UserNotificationsQuery,
    variables: { id: user?.['custom:id'], notificationsLimit: 8, read: false },
    pause: !user?.['custom:id'],
  });
  const [, markNotificationAsRead] = useMutation(MarkNotificationAsRead);

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

  useEffect(() => {
    const intervalId = setInterval(() => {
      if (user?.['custom:id']) {
        reexecuteUserNotificationsQuery({ requestPolicy: 'network-only' });
      }
    }, 30000);

    return () => clearInterval(intervalId);
  }, [reexecuteUserNotificationsQuery, user]);

  useEffect(() => {
    if (!stale) {
      setNotifications(userNotificationsResult?.user?.notifications);
    }
  }, [stale, userNotificationsResult?.user?.notifications]);

  const initials = user ? `${user.given_name?.[0] ?? ''}${user.family_name?.[0] ?? ''}`.toUpperCase() : '';

  return (
    <AppBar position="static" elevation={0} sx={{ height: NAV_HEIGHT }}>
      <Toolbar
        disableGutters
        sx={{
          height: NAV_HEIGHT,
          minHeight: `${NAV_HEIGHT}px !important`,
          px: 3,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          maxWidth: 'md',
          width: '100%',
          mx: 'auto',
        }}
      >
        <Link
          to="/"
          style={{
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            color: 'inherit',
            padding: '4px 8px 4px 0',
            borderRadius: 6,
          }}
        >
          <Box
            sx={{
              bgcolor: 'secondary.light',
              borderRadius: '8px',
              p: '5px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <img
              src={process.env.PUBLIC_URL + '/logo192.png'}
              alt="Train Price Monitor Logo"
              style={{ width: 34, height: 34, display: 'block' }}
            />
          </Box>
          {!isScreenSmall && (
            <Typography sx={{ fontWeight: 700, fontSize: 16, color: '#fff', whiteSpace: 'nowrap' }}>
              Train Price Monitor
            </Typography>
          )}
        </Link>

        {user && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
            <Button
              component={Link}
              to="/search"
              startIcon={<SearchIcon sx={{ fontSize: '16px !important' }} />}
              sx={navBtnSx}
            >
              {!isScreenSmall && 'Search'}
            </Button>
            <Button
              component={Link}
              to="/journeys"
              startIcon={<TrainIcon sx={{ fontSize: '16px !important' }} />}
              sx={navBtnSx}
            >
              {!isScreenSmall && 'Journey Watchlist'}
            </Button>
            <IconButton
              size="small"
              onClick={handleNotificationClick}
              sx={{
                color: 'rgba(255,255,255,0.8)',
                '&:hover': { color: '#fff', backgroundColor: 'rgba(255,255,255,0.13)' },
              }}
            >
              <Badge
                badgeContent={notifications?.length}
                color="error"
                sx={{ '& .MuiBadge-badge': { fontSize: 10, minWidth: 16, height: 16 } }}
              >
                <NotificationsIcon sx={{ fontSize: 18 }} />
              </Badge>
            </IconButton>
            <IconButton aria-label="user profile" onClick={handleAccountClick} sx={{ ml: 0.5, p: 0 }}>
              <Avatar
                alt="Profile Picture"
                src={userProfilePictureUrl || undefined}
                sx={{
                  width: 28,
                  height: 28,
                  fontSize: 10,
                  fontWeight: 700,
                  bgcolor: 'secondary.light',
                  color: 'secondary.dark',
                  border: '2px solid rgba(255,255,255,0.25)',
                }}
                slotProps={{ img: { crossOrigin: 'anonymous' } }}
              >
                {initials}
              </Avatar>
            </IconButton>
          </Box>
        )}
      </Toolbar>
      <NotificationPopover
        anchorEl={notificationAnchorEl}
        id={id}
        open={open}
        onClose={handleNotificationClose}
        notifications={notifications}
        onMarkAsRead={(notificationId: string) => {
          markNotificationAsRead({ userId: user?.['custom:id'], notificationId });
          setNotifications(notifications.filter((notification) => notification.id !== notificationId));
        }}
        handleNotificationClicked={(notification: Notification) => {
          if (notification?.type === 'PRICE_ALERT') {
            navigate(`/journeys#${notification.journeyMonitor?.id}`);
          } else if (notification?.type === 'JOURNEY_EXPIRED') {
            navigate(`/journeys`);
          } else if (notification?.type === 'JOURNEY_STALE') {
            navigate(notification.journeyId ? `/journeys#${notification.journeyId}` : '/journeys');
          }
          handleNotificationClose();
        }}
      />
      <AccountMenu anchorEl={accountAnchorEl} onClose={handleAccountClose} />
    </AppBar>
  );
};

export default Header;
