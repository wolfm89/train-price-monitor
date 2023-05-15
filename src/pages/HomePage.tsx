import React from 'react';
import { Button, Container, Typography } from '@mui/material';

interface Props { }

const HomePage: React.FC<Props> = () => {
  return (
    <Container maxWidth="md" sx={{ my: 4 }} >
        <Typography variant="h4">
        Never overpay for train tickets again
        </Typography>
        <Typography variant="body1" sx={{ my: 2 }}>
        With Train Price Monitor, you can track the prices of train tickets and get notified when they increase. Sign up today to start monitoring your train prices!
        </Typography>
        <Button variant="contained" sx={{ my: 2 }}>Sign up now</Button>
    </Container>
  );
};

export default HomePage;

