import React, { useContext, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  TextField,
} from '@mui/material';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';
import { AuthContext } from '../providers/AuthProvider';
import { Link as RouterLink } from 'react-router-dom';

interface Props {
  open: boolean;
  onClose: () => void;
}

const LoginModal: React.FC<Props> = ({ open, onClose }) => {
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { addAlert } = useAlert();
  const { signIn } = useContext(AuthContext);

  const resetAndClose = () => {
    setEmail('');
    setPassword('');
    setFieldErrors({});
    setFormError('');
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const nextErrors: { email?: string; password?: string } = {};
    if (!email.trim()) nextErrors.email = 'Enter your email address.';
    if (!password) nextErrors.password = 'Enter your password.';
    if (nextErrors.email || nextErrors.password) {
      setFieldErrors(nextErrors);
      (nextErrors.email ? emailRef : passwordRef).current?.focus();
      return;
    }

    setFieldErrors({});
    setFormError('');
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      addAlert('Sign in successful!', AlertSeverity.Success);
      resetAndClose();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
      passwordRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={resetAndClose}>
      <DialogTitle>Log in</DialogTitle>
      <DialogContent>
        <Box component="form" id="login-form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
          <TextField
            margin="dense"
            id="login-email"
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            fullWidth
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setFieldErrors((prev) => ({ ...prev, email: undefined }));
              setFormError('');
            }}
            inputRef={emailRef}
            error={Boolean(fieldErrors.email)}
            helperText={fieldErrors.email ?? ''}
            required
          />
          <TextField
            margin="dense"
            id="login-password"
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            fullWidth
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFieldErrors((prev) => ({ ...prev, password: undefined }));
              setFormError('');
            }}
            inputRef={passwordRef}
            error={Boolean(fieldErrors.password)}
            helperText={fieldErrors.password ?? ''}
            required
          />
          {formError && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {formError}
            </Alert>
          )}
          <Link component={RouterLink} to="/forgot-password" color="inherit">
            Forgot password?
          </Link>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={resetAndClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="login-form"
          variant="contained"
          color="primary"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? (
            <>
              <CircularProgress size={16} color="inherit" sx={{ mr: 1 }} />
              Signing in…
            </>
          ) : (
            'Log in'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default LoginModal;
