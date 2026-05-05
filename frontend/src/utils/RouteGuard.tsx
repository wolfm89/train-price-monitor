import React, { useContext } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthContext } from '../providers/AuthProvider';

interface RouteGuardProps {
  children: React.ReactNode;
}

function RouteGuard({ children }: RouteGuardProps) {
  const { user, isInitialCheckDone } = useContext(AuthContext);

  if (!isInitialCheckDone) {
    return <></>;
  }

  if (!user) {
    return <Navigate to="/" />;
  }

  return <>{children}</>;
}

export default RouteGuard;
