import React, { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField } from '@mui/material';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';
import { signIn } from '../utils/auth';

interface Props {
  open: boolean;
  onClose: () => void;
}

const LoginModal: React.FC<Props> = ({ open, onClose }) => {
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const { addAlert } = useAlert();

  const handleLogin = async () => {
    try {
      await signIn(email, password);
    } catch (err: any) {
      addAlert(err.message, AlertSeverity.Error);
      return;
    }
    addAlert('Sign in successful!', AlertSeverity.Success);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Login</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          margin="dense"
          id="email"
          label="Email"
          type="text"
          fullWidth
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          margin="dense"
          id="password"
          label="Password"
          type="password"
          fullWidth
          onChange={(e) => setPassword(e.target.value)}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleLogin} variant="contained" color="primary">
          Login
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default LoginModal;
