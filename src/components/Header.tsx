import React from 'react';
import { Link } from 'react-router-dom';
import { AppBar, Toolbar, Typography, IconButton, Badge, Container } from '@mui/material';
import { Search as SearchIcon, AccountCircle as AccountCircleIcon, Notifications as NotificationsIcon, Train as TrainIcon } from '@mui/icons-material';

const Header = () => {
    return (
        <AppBar position="static" sx={{ maxWidth: "lg", mx: "auto" }}>
            <Container maxWidth="xl">
                <Toolbar disableGutters sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Link to="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', color: 'inherit' }}>
                        <img src={process.env.PUBLIC_URL + '/logo192.png'} alt="Train Price Monitor Logo" style={{ width: 50, height: 50, marginRight: 2 }} />
                        <Typography variant="h6" component="div" sx={{ marginLeft: 1, color: 'inherit' }}>
                            Train Price Monitor
                        </Typography>
                    </Link>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <Link to="/search" style={{ textDecoration: 'none', marginRight: 16, color: 'inherit', display: 'flex', alignItems: 'center' }}>
                            <IconButton color="inherit" sx={{ borderRadius: 4 }}>
                                <SearchIcon />
                                <Typography variant="subtitle1" component="div" sx={{ marginLeft: 1, xs: 'none', md: 'block', color: 'inherit' }}>
                                    Search
                                </Typography>
                            </IconButton>
                        </Link>
                        <Link to="/my-journeys" style={{ textDecoration: 'none', marginRight: 16, color: 'inherit', display: 'flex', alignItems: 'center' }}>
                            <IconButton color="inherit" sx={{ borderRadius: 4 }}>
                                <TrainIcon />
                                <Typography variant="subtitle1" component="div" sx={{ marginLeft: 1, xs: 'none', md: 'block', color: 'inherit' }}>
                                    My Journeys
                                </Typography>
                            </IconButton>
                        </Link>
                        <IconButton color="inherit">
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
        </AppBar>
    );
};

export default Header;
