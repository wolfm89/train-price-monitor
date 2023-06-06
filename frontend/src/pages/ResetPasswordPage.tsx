import React, { useState } from 'react';
import { Typography, Box, TextField, Button, Grid } from '@mui/material';
import { confirmPassword } from '../utils/auth';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';
import { Link as RouterLink } from 'react-router-dom';

export default function ResetPasswordPage() {
  const [email, setEmail] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [success, setSuccess] = useState(false);
  const { addAlert } = useAlert();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      await confirmPassword(email, confirmationCode, newPassword);
      setSuccess(true);
      addAlert('Your password has been reset successfully!', AlertSeverity.Success);
    } catch (err: any) {
      addAlert(err.message, AlertSeverity.Error);
    }
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Reset Password
      </Typography>
      <form onSubmit={handleSubmit}>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            <TextField
              type="text"
              label="Email"
              variant="outlined"
              fullWidth
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              margin="normal"
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              type="text"
              label="Confirmation code"
              variant="outlined"
              fullWidth
              value={confirmationCode}
              onChange={(e) => setConfirmationCode(e.target.value)}
              margin="normal"
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              type="password"
              label="New password"
              variant="outlined"
              fullWidth
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              margin="normal"
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <Box />
          </Grid>
          <Grid item xs={12} sm={6}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Button
                type="submit"
                variant="contained"
                color="primary"
                disabled={success || !email || !confirmationCode || !newPassword}
              >
                Submit
              </Button>
              {success && (
                <Button component={RouterLink} to="/" variant="contained" color="primary">
                  Back to Home
                </Button>
              )}
            </Box>
          </Grid>
        </Grid>
      </form>
    </Box>
  );
}
