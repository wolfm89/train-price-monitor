import React, { useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Grid, TextField, Typography } from '@mui/material';
import { confirmPassword } from '../utils/auth';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';
import { Link as RouterLink } from 'react-router-dom';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ResetPasswordPage() {
  const [email, setEmail] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { addAlert } = useAlert();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLoading) return;

    let firstInvalid: React.RefObject<HTMLInputElement | null> | null = null;
    if (!email.trim()) {
      setEmailError('Enter your email address.');
      firstInvalid = emailRef;
    } else if (!EMAIL_PATTERN.test(email)) {
      setEmailError('Enter a valid email address.');
      firstInvalid = emailRef;
    } else {
      setEmailError('');
    }

    if (!confirmationCode.trim()) {
      setCodeError('Enter the confirmation code from your email.');
      firstInvalid = firstInvalid ?? codeRef;
    } else {
      setCodeError('');
    }

    if (!newPassword) {
      setPasswordError('Choose a new password.');
      firstInvalid = firstInvalid ?? passwordRef;
    } else {
      setPasswordError('');
    }

    if (firstInvalid) {
      firstInvalid.current?.focus();
      return;
    }

    setFormError('');
    setIsLoading(true);
    try {
      await confirmPassword(email, confirmationCode, newPassword);
      setSuccess(true);
      addAlert('Your password has been reset successfully!', AlertSeverity.Success);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box>
      <Typography variant="h4" component="h1" gutterBottom>
        Reset password
      </Typography>
      <form onSubmit={handleSubmit} noValidate aria-busy={isLoading}>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              id="reset-password-email"
              name="email"
              type="email"
              label="Email"
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
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              id="reset-password-code"
              name="confirmationCode"
              type="text"
              label="Confirmation code"
              autoComplete="one-time-code"
              inputMode="numeric"
              spellCheck={false}
              variant="outlined"
              fullWidth
              value={confirmationCode}
              onChange={(event) => {
                setConfirmationCode(event.target.value);
                setCodeError('');
              }}
              margin="normal"
              inputRef={codeRef}
              required
              error={Boolean(codeError)}
              helperText={codeError}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              id="reset-password-new-password"
              name="newPassword"
              type="password"
              label="New password"
              autoComplete="new-password"
              variant="outlined"
              fullWidth
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
                setPasswordError('');
              }}
              margin="normal"
              inputRef={passwordRef}
              required
              error={Boolean(passwordError)}
              helperText={passwordError}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Box />
          </Grid>
          <Grid size={12}>{formError && <Alert severity="error">{formError}</Alert>}</Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
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
                    Setting password…
                  </>
                ) : (
                  'Set new password'
                )}
              </Button>
              {success && (
                <Button component={RouterLink} to="/" variant="contained" color="primary">
                  Back to home
                </Button>
              )}
            </Box>
          </Grid>
        </Grid>
      </form>
    </Box>
  );
}
