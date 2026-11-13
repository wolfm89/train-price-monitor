import React, { useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Grid, TextField, Typography } from '@mui/material';
import { forgotPassword } from '../utils/auth';
import { Link as RouterLink } from 'react-router-dom';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [formError, setFormError] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const { addAlert } = useAlert();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLoading) return;

    if (!email.trim()) {
      setEmailError('Enter your email address.');
      emailRef.current?.focus();
      return;
    }
    if (!EMAIL_PATTERN.test(email)) {
      setEmailError('Enter a valid email address.');
      emailRef.current?.focus();
      return;
    }

    setEmailError('');
    setFormError('');
    setIsLoading(true);

    try {
      await forgotPassword(email);
      addAlert('Check your email for the confirmation code to reset your password.', AlertSeverity.Success);
      setSuccess(true);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box>
      <Typography variant="h4" component="h1" gutterBottom>
        Forgot password
      </Typography>
      <form onSubmit={handleSubmit} noValidate aria-busy={isLoading}>
        <Grid container spacing={2} alignItems="center">
          <Grid size={{ xs: 12, sm: 5 }}>
            <TextField
              id="forgot-password-email"
              name="email"
              label="Email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              variant="outlined"
              fullWidth
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError('');
              }}
              margin="normal"
              inputRef={emailRef}
              required
              error={Boolean(emailError)}
              helperText={emailError}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <Button
              type="submit"
              variant="contained"
              color="primary"
              disabled={isLoading || success}
              aria-busy={isLoading}
            >
              {isLoading ? (
                <>
                  <CircularProgress size={18} color="inherit" sx={{ mr: 1 }} />
                  Sending…
                </>
              ) : (
                'Send reset code'
              )}
            </Button>
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            {success && (
              <Button component={RouterLink} to="/reset-password" variant="contained" color="primary">
                Choose new password
              </Button>
            )}
          </Grid>
          {formError && (
            <Grid size={12}>
              <Alert severity="error">{formError}</Alert>
            </Grid>
          )}
        </Grid>
      </form>
    </Box>
  );
}
