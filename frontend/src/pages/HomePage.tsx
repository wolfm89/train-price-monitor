import React, { useContext, useEffect, useState } from 'react';
import SignupModal from '../components/SignupModal';
import LoginModal from '../components/LoginModal';
import { Button, Typography, Box, CircularProgress } from '@mui/material';
import { AuthContext } from '../providers/AuthProvider';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';
import { UserExistsQuery, CreateUser } from '../api/user';
import { useMutation, useQuery } from 'urql';

interface Props {}

const HomePage: React.FC<Props> = () => {
  const [signupModalOpen, setSignupModalOpen] = useState<boolean>(false);
  const [loginModalOpen, setLoginModalOpen] = useState<boolean>(false);
  const { addAlert } = useAlert();
  const { user } = useContext(AuthContext);
  const [userExistsResult, reexecuteUserExistsQuery] = useQuery({
    query: UserExistsQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });
  const [, createUser] = useMutation(CreateUser);

  useEffect(() => {
    if (!user || userExistsResult.fetching) {
      return;
    }
    const userExists = !!userExistsResult.data?.user?.id;
    if (!userExists) {
      createUser({
        id: user['custom:id'],
        email: user['email'],
        familyName: user['family_name'],
        givenName: user['given_name'],
      })
        .then((result) => {
          if (result.error) {
            addAlert(result.error.message, AlertSeverity.Error);
          } else {
            reexecuteUserExistsQuery({ requestPolicy: 'network-only' });
          }
        })
        .catch((reason) => {
          console.log(reason);
        });
    }
  }, [addAlert, createUser, reexecuteUserExistsQuery, user, userExistsResult]);

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
      {!user && !userExistsResult.fetching ? (
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
      ) : (
        userExistsResult.fetching && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100px' }}>
            <CircularProgress />
          </div>
        )
      )}
    </>
  );
};

export default HomePage;
