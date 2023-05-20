import React, { useState, useCallback, ReactNode } from 'react';

export enum AlertSeverity {
  Success = 'success',
  Error = 'error',
  Info = 'info',
  Warning = 'warning',
}

interface Alert {
  message: string;
  severity: AlertSeverity;
}

interface AlertContextValue {
  alert: Alert | null;
  addAlert: (message: string, severity: AlertSeverity) => void;
  removeAlert: () => void;
}

export const AlertContext = React.createContext<AlertContextValue>({
  alert: null,
  addAlert: () => {},
  removeAlert: () => {},
});

const AlertProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [alert, setAlert] = useState<Alert | null>(null);

  const removeAlert = () => setAlert(null);

  const addAlert = (message: string, severity: AlertSeverity) => setAlert({ message, severity });

  const contextValue: AlertContextValue = {
    alert,
    addAlert: useCallback((message: string, severity: AlertSeverity) => addAlert(message, severity), []),
    removeAlert: useCallback(() => removeAlert(), []),
  };

  return <AlertContext.Provider value={contextValue}>{children}</AlertContext.Provider>;
};

export default AlertProvider;
