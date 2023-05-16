import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AppBar, Toolbar, Typography, IconButton, Badge, Container, useMediaQuery, useTheme } from '@mui/material';
import { Search as SearchIcon, AccountCircle as AccountCircleIcon, Notifications as NotificationsIcon, Train as TrainIcon } from '@mui/icons-material';
import NotificationPopover from './NotificationPopover';

const Header = () => {
    const theme = useTheme();
    const isScreenSmall = useMediaQuery(theme.breakpoints.down('sm'));

    const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);

    const handleNotificationClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        setAnchorEl(event.currentTarget);
    };


    const handleNotificationClose = () => {
        setAnchorEl(null);
    };

    const open = Boolean(anchorEl);
    const id = open ? 'notification-popover' : undefined;

    return (
        <AppBar position="static" sx={{ maxWidth: "lg", mx: "auto" }}>
            <Container maxWidth="xl">
                <Toolbar disableGutters sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Link to="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', color: 'inherit', marginLeft: -5 }}>
                        <img src={process.env.PUBLIC_URL + '/logo192.png'} alt="Train Price Monitor Logo" style={{ width: 50, height: 50, marginRight: 2 }} />
                        <Typography variant="h6" component="div" sx={{ marginLeft: 1, color: 'inherit', whiteSpace: 'nowrap' }}>
                            Train Price Monitor
                        </Typography>
                    </Link>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <Link to="/search" style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center' }}>
                            <IconButton color="inherit" sx={{ borderRadius: 4 }}>
                                <SearchIcon />
                                {!isScreenSmall && (
                                    <Typography variant="subtitle1" component="div" sx={{ marginLeft: 1, xs: 'none', md: 'block', color: 'inherit' }}>
                                        Search
                                    </Typography>
                                )}
                            </IconButton>
                        </Link>
                        <Link to="/journeys" style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center' }}>
                            <IconButton color="inherit" sx={{ borderRadius: 4 }}>
                                <TrainIcon />
                                {!isScreenSmall && (
                                    <Typography variant="subtitle1" component="div" sx={{ marginLeft: 1, xs: 'none', md: 'block', color: 'inherit' }}>
                                        My Journeys
                                    </Typography>
                                )}
                            </IconButton>
                        </Link>
                        <IconButton color="inherit" onClick={handleNotificationClick}>
                            <Badge badgeContent={4} color="error">
                                <NotificationsIcon />
                            </Badge>
                        </IconButton>
                        <IconButton aria-label="user profile" color="inherit">
                            <AccountCircleIcon />
                        </IconButton>
                    </div>
                </Toolbar>
            </Container>
            <NotificationPopover
                anchorEl={anchorEl}
                id={id}
                open={open}
                onClose={handleNotificationClose}
            />
        </AppBar>
    );
};

export default Header;
