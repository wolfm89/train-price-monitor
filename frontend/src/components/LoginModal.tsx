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
  const [errorMessage, setErrorMessage] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { addAlert } = useAlert();
  const { signIn } = useContext(AuthContext);

  const resetAndClose = () => {
    setEmail('');
    setPassword('');
    setErrorMessage('');
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    if (!email.trim()) {
      setErrorMessage('Enter your email address.');
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setErrorMessage('Enter your password.');
      passwordRef.current?.focus();
      return;
    }

    setSubmitting(true);
    setErrorMessage('');
    try {
      await signIn(email, password);
      addAlert('Sign in successful!', AlertSeverity.Success);
      resetAndClose();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
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
              setErrorMessage('');
            }}
            inputRef={emailRef}
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
              setErrorMessage('');
            }}
            inputRef={passwordRef}
            required
          />
          {errorMessage && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {errorMessage}
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
