import { Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField } from '@mui/material';
import React, { useState } from 'react';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';
import { signUp } from '../utils/auth';
import { CreateUser } from '../api/user';
import { useMutation } from 'urql';

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
  const [_, createUser] = useMutation(CreateUser);

  const handleSignUp = async () => {
    try {
      await signUp(givenName, familyName, email, password);
    } catch (err: any) {
      addAlert(err.message, AlertSeverity.Error);
      return;
    }
    createUser({ email, familyName, givenName })
      .then((result) => {
        console.log(result);
        if (result.error) {
          addAlert(result.error.message, AlertSeverity.Error);
        }
      })
      .catch((reason) => {
        console.log(reason);
      });
    addAlert('Sign up successful! Please check your emails and confirm your account.', AlertSeverity.Success);
    onClose();
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSignUp();
    }
  };

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
        />
        <TextField
          margin="dense"
          label="Password"
          type="password"
          fullWidth
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyPress={handleKeyPress}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSignUp} variant="contained" color="primary">
          Sign Up
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SignupModal;
