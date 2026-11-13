import React, { useEffect, useRef, useState } from 'react';
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
  Typography,
} from '@mui/material';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';
import { signUp } from '../utils/auth';
import { PRIVACY_POLICY_URL } from '../utils/legalLinks';
import { v4 as uuidv4 } from 'uuid';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface SignupErrors {
  givenName?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SignupValues {
  givenName: string;
  email: string;
  password: string;
  confirmPassword: string;
}

function validateSignup(values: SignupValues): SignupErrors {
  const next: SignupErrors = {};
  if (!values.givenName.trim()) next.givenName = 'Enter your first name.';
  if (!values.email.trim()) next.email = 'Enter your email address.';
  else if (!EMAIL_PATTERN.test(values.email)) next.email = 'Enter a valid email address.';
  if (!values.password) next.password = 'Choose a password.';
  if (!values.confirmPassword) next.confirmPassword = 'Confirm your password.';
  else if (values.password !== values.confirmPassword) next.confirmPassword = 'Passwords do not match.';
  return next;
}

const SignupModal: React.FC<Props> = ({ open, onClose }) => {
  const [email, setEmail] = useState<string>('');
  const [givenName, setGivenName] = useState<string>('');
  const [familyName, setFamilyName] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [errors, setErrors] = useState<SignupErrors>({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const givenNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const { addAlert } = useAlert();

  useEffect(() => {
    if (!submitted) return;
    setErrors(validateSignup({ givenName, email, password, confirmPassword }));
  }, [submitted, givenName, email, password, confirmPassword]);

  useEffect(() => {
    if (submitted) setFormError('');
  }, [submitted, givenName, email, password, confirmPassword]);

  const resetAndClose = () => {
    setEmail('');
    setGivenName('');
    setFamilyName('');
    setPassword('');
    setConfirmPassword('');
    setErrors({});
    setFormError('');
    setSubmitted(false);
    onClose();
  };

  const focusFirstError = (nextErrors: SignupErrors) => {
    if (nextErrors.givenName) givenNameRef.current?.focus();
    else if (nextErrors.email) emailRef.current?.focus();
    else if (nextErrors.password) passwordRef.current?.focus();
    else if (nextErrors.confirmPassword) confirmPasswordRef.current?.focus();
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitted(true);
    const nextErrors = validateSignup({ givenName, email, password, confirmPassword });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstError(nextErrors);
      return;
    }

    const userId = uuidv4();
    setSubmitting(true);
    setFormError('');
    try {
      await signUp(userId, givenName, familyName, email, password);
      addAlert('Sign up successful! Please check your emails and confirm your account.', AlertSeverity.Success);
      resetAndClose();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={resetAndClose}>
      <DialogTitle>Sign up</DialogTitle>
      <DialogContent>
        <Box component="form" id="signup-form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
          <TextField
            margin="dense"
            id="signup-given-name"
            name="givenName"
            label="First name"
            type="text"
            autoComplete="given-name"
            fullWidth
            value={givenName}
            onChange={(e) => setGivenName(e.target.value)}
            inputRef={givenNameRef}
            required
            error={Boolean(errors.givenName)}
            helperText={errors.givenName}
          />
          <TextField
            margin="dense"
            id="signup-family-name"
            name="familyName"
            label="Last name"
            type="text"
            autoComplete="family-name"
            fullWidth
            value={familyName}
            onChange={(e) => setFamilyName(e.target.value)}
          />
          <TextField
            margin="dense"
            id="signup-email"
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            fullWidth
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputRef={emailRef}
            required
            error={Boolean(errors.email)}
            helperText={errors.email}
          />
          <TextField
            margin="dense"
            id="signup-password"
            name="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            fullWidth
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            inputRef={passwordRef}
            required
            error={Boolean(errors.password)}
            helperText={errors.password}
          />
          <TextField
            margin="dense"
            id="signup-confirm-password"
            name="confirmPassword"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            fullWidth
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            inputRef={confirmPasswordRef}
            required
            error={Boolean(errors.confirmPassword)}
            helperText={errors.confirmPassword}
          />
          {formError && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {formError}
            </Alert>
          )}
          <Typography sx={{ mt: 1.5, fontSize: 12, color: 'text.secondary', lineHeight: 1.55 }}>
            Your name and email address are used to run your account and to send the alerts you set up. Details are in
            the{' '}
            <Link href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
              privacy policy
            </Link>
            .
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={resetAndClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="signup-form"
          variant="contained"
          color="primary"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? (
            <>
              <CircularProgress size={16} color="inherit" sx={{ mr: 1 }} />
              Creating account…
            </>
          ) : (
            'Sign up'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SignupModal;
