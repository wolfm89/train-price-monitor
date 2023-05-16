import React, { useState } from 'react';
import SignupModal from '../components/SignupModal';
import LoginModal from '../components/LoginModal';
import { Button, Container, Typography, Box } from '@mui/material';

interface Props { }

const HomePage: React.FC<Props> = () => {
  const [open, setOpen] = useState<boolean>(false);
  const [loginOpen, setLoginOpen] = useState<boolean>(false);


  const handleModalOpen = () => {
    setOpen(true);
  };

  const handleModalClose = () => {
    setOpen(false);
  };

  const handleLoginOpen = () => {
    setLoginOpen(true);
  };

  const handleLoginClose = () => {
    setLoginOpen(false);
  };

  return (
    <Container maxWidth="md" sx={{ my: 4 }} >
      <Typography variant="h4">
        Never overpay for train tickets again
      </Typography>
      <Typography variant="body1" sx={{ my: 2 }}>
        With Train Price Monitor, you can track the prices of train tickets and get notified when they increase. Sign up today to start monitoring your train prices!
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button variant="contained" onClick={handleModalOpen}>Sign up now</Button>
        <SignupModal open={open} onClose={handleModalClose} />
        <Typography variant="body1">or</Typography>
        <Button variant="contained" onClick={handleLoginOpen}>Login</Button>
        <LoginModal open={loginOpen} onClose={handleLoginClose} />
      </Box>
    </Container>
  );
};

export default HomePage;

