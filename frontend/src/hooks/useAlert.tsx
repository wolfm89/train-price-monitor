import { useContext } from 'react';
import { AlertContext, AlertSeverity } from '../providers/AlertProvider';

interface AlertContextType {
  alert: { message: string; severity: AlertSeverity } | null;
  addAlert: (message: string, severity: AlertSeverity) => void;
  removeAlert: () => void;
}

function useAlert(): AlertContextType {
  const { alert, addAlert, removeAlert } = useContext(AlertContext);
  return { alert, addAlert, removeAlert };
}

export default useAlert;
