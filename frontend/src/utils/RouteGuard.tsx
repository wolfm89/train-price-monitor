import React, { useContext } from 'react';
import { Navigate } from 'react-router-dom';
import { CircularProgress, Box } from '@mui/material';
import { AuthContext } from '../providers/AuthProvider';

interface RouteGuardProps {
  children: React.ReactNode;
}

function RouteGuard({ children }: RouteGuardProps) {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('RouteGuard must be used within an AuthProvider');
  }

  const { user, isInitialCheckDone } = context;

  if (!isInitialCheckDone) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    return <Navigate to="/" />;
  }

  return <>{children}</>;
}

export default RouteGuard;
