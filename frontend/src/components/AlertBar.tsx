import React from 'react';
import useAlert from '../hooks/useAlert';
import { Snackbar } from '@mui/material';
import MuiAlert, { AlertProps } from '@mui/material/Alert';

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(props, ref) {
  return <MuiAlert elevation={6} ref={ref} variant="filled" {...props} />;
});

const AlertBar: React.FC = () => {
  const { alert, removeAlert } = useAlert();

  const onClose = () => {
    removeAlert();
  };

  return (
    <Snackbar
      open={!!alert}
      anchorOrigin={{
        vertical: 'top',
        horizontal: 'center',
      }}
      autoHideDuration={5000}
      onClose={onClose}
      message="Sign up successful!"
    >
      <Alert onClose={onClose} severity={alert?.severity} sx={{ width: '100%' }}>
        {alert?.message}
      </Alert>
    </Snackbar>
  );
};

export default AlertBar;
