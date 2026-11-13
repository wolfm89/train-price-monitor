import React, { useContext } from 'react';
import { Navigate } from 'react-router-dom';
import LoadingStatus from '../components/LoadingStatus';
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
    return <LoadingStatus label="Checking your session…" minHeight={200} />;
  }

  if (!user) {
    return <Navigate to="/" />;
  }

  return <>{children}</>;
}

export default RouteGuard;
