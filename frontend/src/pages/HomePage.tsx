import React, { useContext, useEffect, useState } from 'react';
import SignupModal from '../components/SignupModal';
import LoginModal from '../components/LoginModal';
import { Button, Typography, Box } from '@mui/material';
import { AuthContext } from '../providers/AuthProvider';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';
import { UserActivationStatusQuery, ActivateUser } from '../api/user';
import { useMutation, useQuery } from 'urql';

interface Props {}

const HomePage: React.FC<Props> = () => {
  const [signupModalOpen, setSignupModalOpen] = useState<boolean>(false);
  const [loginModalOpen, setLoginModalOpen] = useState<boolean>(false);
  const { addAlert } = useAlert();
  const { user } = useContext(AuthContext);
  const [userActivatedResult] = useQuery({
    query: UserActivationStatusQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user,
  });
  const [, activateUser] = useMutation(ActivateUser);

  useEffect(() => {
    const activated = userActivatedResult.data?.user?.activated;
    if (user && activated === false) {
      activateUser({ id: user?.['custom:id'] }).then((result) => {
        if (result.error) {
          addAlert(result.error.message, AlertSeverity.Error);
        }
      });
    }
  }, [activateUser, addAlert, user, userActivatedResult]);

  const handleModalOpen = () => {
    setSignupModalOpen(true);
  };

  const handleModalClose = () => {
    setSignupModalOpen(false);
  };

  const handleLoginOpen = () => {
    setLoginModalOpen(true);
  };

  const handleLoginClose = () => {
    setLoginModalOpen(false);
  };

  return (
    <>
      <Typography variant="h4">Never overpay for train tickets again</Typography>
      <Typography variant="body1" sx={{ my: 2 }}>
        With Train Price Monitor, you can track the prices of train tickets and get notified when they increase. Sign up
        today to start monitoring your train prices!
      </Typography>
      {!user && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button variant="contained" onClick={handleModalOpen}>
            Sign up now
          </Button>
          <SignupModal open={signupModalOpen} onClose={handleModalClose} />
          <Typography variant="body1">or</Typography>
          <Button variant="contained" onClick={handleLoginOpen}>
            Login
          </Button>
          <LoginModal open={loginModalOpen} onClose={handleLoginClose} />
        </Box>
      )}
    </>
  );
};

export default HomePage;
