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

  const SlideTransition = (props: any) => {
    return <Slide {...props} direction="down" />;
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
        TransitionComponent={SlideTransition}
      >
        <Alert onClose={onClose} severity={alert?.severity} sx={{ width: '100%' }}>
          {alert?.message}
        </Alert>
      </Snackbar>
    )
  );
};

export default AlertBar;
