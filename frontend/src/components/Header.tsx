import React, { useContext, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
import LoginModal from './LoginModal';
import { AuthContext } from '../providers/AuthProvider';
import { UserNotificationsQuery } from '../api/user';
import { useMutation, useQuery } from 'urql';
import { MarkNotificationAsRead } from '../api/notification';

const NAV_HEIGHT = 54;

const navBtnSx = {
  color: 'rgba(255,255,255,0.85)',
  fontSize: 13,
  fontWeight: 500,
  borderRadius: '8px',
  border: '1.5px solid rgba(255,255,255,0.35)',
  px: { xs: 1.25, sm: 1.75 },
  py: 0,
  minWidth: { xs: 44, sm: 0 },
  minHeight: { xs: 44, sm: 40 },
  textTransform: 'none' as const,
  '& .MuiButton-startIcon': {
    marginRight: { xs: 0, sm: '8px' }, // collapse icon trailing margin when no text follows on mobile
    marginLeft: { xs: 0, sm: '-4px' }, // reset MUI's default -4px left margin on mobile so icon stays centered
  },
  '&:hover': {
    backgroundColor: 'rgba(255,255,255,0.13)',
    borderColor: 'rgba(255,255,255,0.55)',
    color: '#fff',
  },
};

const navBtnActiveSx = {
  ...navBtnSx,
  backgroundColor: 'rgba(255,255,255,0.24)',
  borderColor: 'rgba(255,255,255,0.7)',
  color: '#fff',
  fontWeight: 600,
  '&:hover': {
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderColor: 'rgba(255,255,255,0.85)',
    color: '#fff',
  },
};

const Header = () => {
  const theme = useTheme();
  const location = useLocation();
  const isScreenSmall = useMediaQuery(theme.breakpoints.down('sm'));
  const { user, userProfilePictureUrl, isInitialCheckDone } = useContext(AuthContext);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [{ stale, data: userNotificationsResult }, reexecuteUserNotificationsQuery] = useQuery({
    query: UserNotificationsQuery,
    variables: { id: user?.['custom:id'], notificationsLimit: 8, read: false },
    pause: !user?.['custom:id'],
  });
  const [, markNotificationAsRead] = useMutation(MarkNotificationAsRead);

  const [notificationAnchorEl, setNotificationAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [loginModalOpen, setLoginModalOpen] = useState(false);

  const handleNotificationClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setNotificationAnchorEl(event.currentTarget);
  };

  const handleNotificationClose = () => {
    setNotificationAnchorEl(null);
  };

  const open = Boolean(notificationAnchorEl);
  const id = open ? 'notification-popover' : undefined;
  const unreadCount = notifications?.length ?? 0;

  const [accountAnchorEl, setAccountAnchorEl] = useState<HTMLButtonElement | null>(null);

  const handleAccountClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAccountAnchorEl(event.currentTarget);
  };

  const handleAccountClose = () => {
    setAccountAnchorEl(null);
  };

  useEffect(() => {
    const refresh = () => {
      if (user?.['custom:id']) {
        reexecuteUserNotificationsQuery({ requestPolicy: 'network-only' });
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      // Visible tabs poll every 30 s; hidden tabs keep a 10-minute heartbeat.
      const delay = document.visibilityState === 'visible' ? 30_000 : 10 * 60_000;
      timer = setTimeout(() => {
        refresh();
        schedule();
      }, delay);
    };
    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible') refresh();
      schedule();
    };

    schedule();
    document.addEventListener('visibilitychange', refreshWhenActive);
    window.addEventListener('focus', refreshWhenActive);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshWhenActive);
      window.removeEventListener('focus', refreshWhenActive);
    };
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
        <Box
          component={Link}
          to="/"
          sx={{
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 1.125,
            color: 'inherit',
            borderRadius: 1,
            minHeight: { xs: 44, sm: 40 },
            flexShrink: 0,
          }}
        >
          <Box
            sx={{
              width: 40,
              height: 40,
              bgcolor: 'background.paper',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <img
              src={process.env.PUBLIC_URL + '/logo-header.webp'}
              alt="Train Price Monitor Logo"
              width={40}
              height={40}
              style={{ display: 'block', borderRadius: '6px' }}
            />
          </Box>
          {!isScreenSmall && (
            <Typography sx={{ fontWeight: 700, fontSize: 16, color: '#fff', whiteSpace: 'nowrap' }}>
              Train Price Monitor
            </Typography>
          )}
        </Box>

        {/* The auth check is async; rendering the logged-out controls before it
            resolves makes them flash and then disappear for signed-in users. */}
        {isInitialCheckDone && !user && (
          <Button onClick={() => setLoginModalOpen(true)} sx={navBtnSx}>
            Log in
          </Button>
        )}
        {isInitialCheckDone && user && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 2 } }}>
            <Box component="nav" aria-label="Main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Button
                component={Link}
                to="/search"
                startIcon={<SearchIcon />}
                aria-label="Search"
                aria-current={location.pathname === '/search' ? 'page' : undefined}
                sx={location.pathname === '/search' ? navBtnActiveSx : navBtnSx}
              >
                {!isScreenSmall && 'Search'}
              </Button>
              <Button
                component={Link}
                to="/journeys"
                startIcon={<TrainIcon />}
                aria-label="My Journeys"
                aria-current={location.pathname === '/journeys' ? 'page' : undefined}
                sx={location.pathname === '/journeys' ? navBtnActiveSx : navBtnSx}
              >
                {!isScreenSmall && 'My Journeys'}
              </Button>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1.5 } }}>
              <IconButton
                size="small"
                aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? 'notification-popover' : undefined}
                onClick={handleNotificationClick}
                sx={{
                  color: 'rgba(255,255,255,0.85)',
                  border: '1.5px solid rgba(255,255,255,0.35)',
                  borderRadius: '8px',
                  width: { xs: 44, sm: 40 },
                  height: { xs: 44, sm: 40 },
                  p: 0,
                  '&:hover': {
                    color: '#fff',
                    backgroundColor: 'rgba(255,255,255,0.13)',
                    borderColor: 'rgba(255,255,255,0.55)',
                  },
                }}
              >
                <Badge
                  badgeContent={unreadCount}
                  color="error"
                  aria-hidden="true"
                  sx={{ '& .MuiBadge-badge': { fontSize: 10, minWidth: 16, height: 16 } }}
                >
                  <NotificationsIcon sx={{ fontSize: 20 }} />
                </Badge>
              </IconButton>
              <IconButton
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-expanded={Boolean(accountAnchorEl)}
                aria-controls="account-menu"
                onClick={handleAccountClick}
                sx={{
                  p: 0,
                  width: { xs: 44, sm: 40 },
                  height: { xs: 44, sm: 40 },
                  color: 'rgba(255,255,255,0.85)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Avatar
                  alt="Profile Picture"
                  src={userProfilePictureUrl || undefined}
                  sx={{
                    width: 40,
                    height: 40,
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
      />
      <AccountMenu anchorEl={accountAnchorEl} onClose={handleAccountClose} />
      <LoginModal open={loginModalOpen} onClose={() => setLoginModalOpen(false)} />
    </AppBar>
  );
};

export default Header;
