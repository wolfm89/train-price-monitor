import React from 'react';
import useAlert from '../hooks/useAlert';
import { Slide, Snackbar } from '@mui/material';
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
    alert && (
      <Snackbar
        open={!!alert}
        anchorOrigin={{
          vertical: 'top',
          horizontal: 'center',
        }}
        autoHideDuration={5000}
        onClose={onClose}
        // Slide is a stable module-level component and defaults to direction="down".
        // Defining the transition inside this component remounted it on every render.
        slots={{ transition: Slide }}
      >
        <Alert onClose={onClose} severity={alert?.severity} sx={{ width: '100%' }}>
          {alert?.message}
        </Alert>
      </Snackbar>
    )
  );
};

export default AlertBar;
