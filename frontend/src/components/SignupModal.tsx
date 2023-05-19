import { Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField } from '@mui/material';
import React, { useState } from 'react';
import { CognitoUserPool, CognitoUserAttribute, ISignUpResult } from 'amazon-cognito-identity-js';

interface Props {
  open: boolean;
  onClose: () => void;
}

const SignupModal: React.FC<Props> = ({ open, onClose }) => {
  const [email, setEmail] = useState<string>('');
  const [givenName, setGivenName] = useState<string>('');
  const [familyName, setFamilyName] = useState<string>('');
  const [password, setPassword] = useState<string>('');

  const poolData = {
    UserPoolId: process.env.REACT_APP_COGNITO_USER_POOL_ID!,
    ClientId: process.env.REACT_APP_COGNITO_CLIENT_ID!,
  };

  const userPool = new CognitoUserPool(poolData);

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
  };

  const handleGivenNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setGivenName(e.target.value);
  };

  const handleFamilyNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFamilyName(e.target.value);
  };

  const handleSignUp = () => {
    const userAttributes: CognitoUserAttribute[] = [
      new CognitoUserAttribute({ Name: 'email', Value: email }),
      new CognitoUserAttribute({ Name: 'given_name', Value: givenName }),
      new CognitoUserAttribute({ Name: 'family_name', Value: familyName }),
    ];

    userPool.signUp(email, password, userAttributes, [], (err: Error | undefined, result?: ISignUpResult) => {
      if (err) {
        console.error('Error signing up:', err);
        return;
      }
      console.log('Successfully signed up:', result);
    });
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
          onChange={handleGivenNameChange}
        />
        <TextField
          margin="dense"
          id="lastName"
          label="Last Name"
          type="text"
          fullWidth
          value={familyName}
          onChange={handleFamilyNameChange}
        />
        <TextField margin="dense" label="Email" type="email" fullWidth value={email} onChange={handleEmailChange} />
        <TextField
          margin="dense"
          label="Password"
          type="password"
          fullWidth
          value={password}
          onChange={handlePasswordChange}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSignUp} color="primary">
          Sign Up
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SignupModal;
