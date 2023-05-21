import React, { useState } from 'react';
import { Typography, Box, TextField, Button, CircularProgress, Grid } from '@mui/material';
import { forgotPassword } from '../utils/auth';
import { Link as RouterLink } from 'react-router-dom';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { addAlert } = useAlert();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await forgotPassword(email);
      addAlert('Check your email for the confirmation code to reset your password.', AlertSeverity.Success);
      setSuccess(true);
    } catch (err: any) {
      addAlert(err.message, AlertSeverity.Error);
    }

    setIsLoading(false);
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Forgot Password
      </Typography>
      <form onSubmit={handleSubmit}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={5}>
            <TextField
              id="email"
              label="Email"
              variant="outlined"
              fullWidth
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              margin="normal"
            />
          </Grid>
          <Grid item xs={4}>
            <Button type="submit" variant="contained" color="primary" disabled={isLoading || success}>
              {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Submit'}
            </Button>
          </Grid>
          <Grid item xs={4}>
            {success && (
              <Button component={RouterLink} to="/reset-password" variant="contained" color="primary">
                Choose new password
              </Button>
            )}
          </Grid>
        </Grid>
      </form>
    </Box>
  );
}
