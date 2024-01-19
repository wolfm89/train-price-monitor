import { Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField } from '@mui/material';
import React, { useState } from 'react';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';
import { signUp } from '../utils/auth';
import { v4 as uuidv4 } from 'uuid';

interface Props {
  open: boolean;
  onClose: () => void;
}

const SignupModal: React.FC<Props> = ({ open, onClose }) => {
  const [email, setEmail] = useState<string>('');
  const [givenName, setGivenName] = useState<string>('');
  const [familyName, setFamilyName] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const { addAlert } = useAlert();

  const handleSignUp = async () => {
    const userId = uuidv4();
    try {
      await signUp(userId, givenName, familyName, email, password);
    } catch (err: any) {
      addAlert(err.message, AlertSeverity.Error);
      return;
    }
    addAlert('Sign up successful! Please check your emails and confirm your account.', AlertSeverity.Success);
    onClose();
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSignUp();
    }
  };

  const isSignupDisabled = !givenName || !email || !password;

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Sign Up</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          margin="dense"
          id="firstName"
          label="First Name"
          type="text"
          fullWidth
          value={givenName}
          onChange={(e) => setGivenName(e.target.value)}
          onKeyPress={handleKeyPress}
          required
        />
        <TextField
          margin="dense"
          id="lastName"
          label="Last Name"
          type="text"
          fullWidth
          value={familyName}
          onChange={(e) => setFamilyName(e.target.value)}
          onKeyPress={handleKeyPress}
        />
        <TextField
          margin="dense"
          label="Email"
          type="email"
          fullWidth
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyPress={handleKeyPress}
          required
        />
        <TextField
          margin="dense"
          label="Password"
          type="password"
          fullWidth
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyPress={handleKeyPress}
          required
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSignUp} variant="contained" color="primary" disabled={isSignupDisabled}>
          Sign Up
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SignupModal;
