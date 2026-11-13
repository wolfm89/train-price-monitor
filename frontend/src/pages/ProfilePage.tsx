import React, { ChangeEvent, useContext, useEffect, useRef, useState } from 'react';
import {
  Typography,
  Grid,
  TextField,
  Button,
  Avatar,
  Box,
  Link,
  Switch,
  FormControlLabel,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
} from '@mui/material';
import { AuthContext } from '../providers/AuthProvider';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';
import { changePassword } from '../utils/auth';
import { useClient, useMutation, useQuery } from 'urql';
import {
  DeleteUser,
  ExportMyDataQuery,
  UpdateUserProfilePicture,
  UpdateUserSettings,
  UserSettingsQuery,
} from '../api/user';
import { useNavigate } from 'react-router-dom';
import TravelPreferences from '../components/TravelPreferences';
import LoadingStatus from '../components/LoadingStatus';
import useUnsavedChangesWarning from '../hooks/useUnsavedChangesWarning';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';
import { deleteAccountSafely, hasMutationError } from '../utils/accountDeletion';
import { downloadTextFile, exportFileName, withLoginAttributes } from '../utils/dataExport';
import { PRIVACY_CONTACT_EMAIL, PRIVACY_POLICY_URL } from '../utils/legalLinks';

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const sectionTitleSx = {
  display: 'block',
  mb: 1.75,
  pb: 1.25,
  borderBottom: 1,
  borderColor: 'divider',
};

const fieldLabelSx = {
  mb: 0.5,
};

interface PasswordErrors {
  current?: string;
  next?: string;
  confirm?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ProfilePage: React.FC = () => {
  const {
    user,
    userProfilePictureUrl,
    refetchUserProfilePictureUrl,
    deleteUser: deleteCognitoUser,
  } = useContext(AuthContext);
  const navigate = useNavigate();
  const [firstName] = useState(user?.given_name);
  const [lastName] = useState(user?.family_name);
  const [email] = useState(user?.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [enableEmailNotifications, setEnableEmailNotifications] = useState(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [accountDeletionConfirmed, setAccountDeletionConfirmed] = useState(false);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordFormTouched, setPasswordFormTouched] = useState(false);
  const [travelPreferencesDirty, setTravelPreferencesDirty] = useState(false);
  const [passwordErrors, setPasswordErrors] = useState<PasswordErrors>({});
  const { addAlert } = useAlert();
  const [, updateUserProfilePicture] = useMutation(UpdateUserProfilePicture);
  const [{ data: userSettingsData, fetching: userSettingsFetching }] = useQuery({
    query: UserSettingsQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'] || accountDeletionConfirmed,
  });
  const [, updateUserSettings] = useMutation(UpdateUserSettings);
  const [, deleteUser] = useMutation(DeleteUser);
  const client = useClient();
  const [exportingData, setExportingData] = useState(false);
  const profilePictureInputRef = useRef<HTMLInputElement>(null);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const passwordBaselineRef = useRef({ current: '', next: '', confirm: '' });
  const markPasswordFormTouched = () => {
    if (!passwordFormTouched) {
      passwordBaselineRef.current = { current: currentPassword, next: newPassword, confirm: confirmPassword };
      setPasswordFormTouched(true);
    }
  };
  const passwordDirty =
    passwordFormTouched &&
    (currentPassword !== passwordBaselineRef.current.current ||
      newPassword !== passwordBaselineRef.current.next ||
      confirmPassword !== passwordBaselineRef.current.confirm);
  const hasUnsavedChanges = passwordDirty || travelPreferencesDirty;
  const {
    blocked: unsavedChangesBlocked,
    proceed: proceedUnsavedChanges,
    reset: resetUnsavedChanges,
  } = useUnsavedChangesWarning(hasUnsavedChanges);

  useEffect(() => {
    if (userSettingsData) {
      setEnableEmailNotifications(userSettingsData.user?.emailNotificationsEnabled);
    }
  }, [userSettingsData]);

  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
  const allowedMaxSize = 0.5 * 1024 * 1024;

  const handleProfilePictureChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file: File | undefined = event.target.files?.[0];
    event.target.value = '';

    if (file) {
      if (!allowedTypes.includes(file.type)) {
        addAlert('Invalid file type. Only JPEG, PNG, and GIF images are allowed.', AlertSeverity.Error);
        return;
      }

      if (file.size > allowedMaxSize) {
        addAlert('File size exceeds the allowed limit (500 KB).', AlertSeverity.Error);
        return;
      }

      updateUserProfilePicture({ id: user?.['custom:id'], image: file })
        .then((result) => {
          if (hasMutationError(result)) {
            addAlert('Profile picture change failed. Please try again.', AlertSeverity.Error);
            return;
          }
          addAlert('Profile picture changed successfully!', AlertSeverity.Success);
          refetchUserProfilePictureUrl();
        })
        .catch(() => {
          addAlert('Profile picture change failed. Please try again.', AlertSeverity.Error);
        });
    }
  };

  const handlePasswordUpdate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (passwordSubmitting) return;

    const nextErrors: PasswordErrors = {};
    if (!currentPassword) nextErrors.current = 'Enter your current password.';
    if (!newPassword) nextErrors.next = 'Choose a new password.';
    if (!confirmPassword) nextErrors.confirm = 'Confirm your new password.';
    else if (newPassword !== confirmPassword) nextErrors.confirm = 'New passwords do not match.';

    setPasswordErrors(nextErrors);
    if (nextErrors.current) {
      currentPasswordRef.current?.focus();
      return;
    }
    if (nextErrors.next) {
      newPasswordRef.current?.focus();
      return;
    }
    if (nextErrors.confirm) {
      confirmPasswordRef.current?.focus();
      return;
    }

    setPasswordSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      addAlert('Password updated successfully!', AlertSeverity.Success);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordErrors({});
      setPasswordFormTouched(false);
      passwordBaselineRef.current = { current: '', next: '', confirm: '' };
    } catch {
      setPasswordErrors({ confirm: 'Password change failed. Please try again.' });
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const handleNotificationToggle = (_event: ChangeEvent<HTMLInputElement>, checked: boolean) => {
    setEnableEmailNotifications(checked);
    updateUserSettings({ id: user?.['custom:id'], emailNotificationsEnabled: checked }).then((result) => {
      if (result.error) {
        addAlert('Updating user settings failed. Please try again.', AlertSeverity.Error);
        setEnableEmailNotifications(!checked);
      } else {
        addAlert('User settings updated successfully!', AlertSeverity.Success);
      }
    });
  };

  const handleDeleteAccount = () => {
    setShowDeleteConfirmation(true);
  };

  const handleExportData = async () => {
    const userId = user?.['custom:id'];
    if (!userId) return;
    setExportingData(true);
    try {
      const result = await client
        .query(ExportMyDataQuery, { id: userId }, { requestPolicy: 'network-only' })
        .toPromise();
      const exportJson = result.data?.exportMyData;
      if (result.error || typeof exportJson !== 'string') {
        addAlert('Data export failed. Please try again.', AlertSeverity.Error);
        return;
      }
      downloadTextFile(withLoginAttributes(exportJson, user), exportFileName());
      addAlert('Your data export has been downloaded.', AlertSeverity.Success);
    } catch {
      addAlert('Data export failed. Please try again.', AlertSeverity.Error);
    } finally {
      setExportingData(false);
    }
  };

  const handleConfirmDeleteAccount = async () => {
    setAccountDeletionConfirmed(true);
    setShowDeleteConfirmation(false);

    // Backend data first: a failed mutation resolves with `{ error }`, and
    // deleting the Cognito login anyway would orphan journeys and notifications.
    const outcome = await deleteAccountSafely({
      deleteBackendData: () => deleteUser({ id: user?.['custom:id'] }),
      deleteCognitoUser,
    });

    if (!outcome.ok) {
      setAccountDeletionConfirmed(false);
      addAlert(
        outcome.stage === 'cognito'
          ? `Your account data was deleted, but the login could not be removed. Please email ${PRIVACY_CONTACT_EMAIL} to have it removed.`
          : 'Account deletion failed. Please try again.',
        AlertSeverity.Error
      );
      return;
    }

    navigate(`/`);
    addAlert('Account deleted successfully!', AlertSeverity.Success);
  };

  const initials = user ? `${user.given_name?.[0] ?? ''}${user.family_name?.[0] ?? ''}`.toUpperCase() : '';

  if (userSettingsFetching) {
    return <LoadingStatus label="Loading profile…" />;
  }

  return (
    <Box>
      <Typography component="h1" variant="h5" sx={{ mb: 2.5 }}>
        Account settings
      </Typography>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '200px 1fr' }, gap: 3, alignItems: 'start' }}>
        {/* Sidebar */}
        <Paper
          elevation={0}
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: 3,
            p: 2.75,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1.5,
            textAlign: 'center',
          }}
        >
          <Avatar
            alt="Profile Picture"
            src={userProfilePictureUrl || undefined}
            sx={{
              width: 72,
              height: 72,
              fontSize: 26,
              fontWeight: 700,
              bgcolor: 'secondary.light',
              color: 'secondary.dark',
              border: '3px solid',
              borderColor: 'secondary.main',
            }}
            slotProps={{ img: { crossOrigin: 'anonymous' } }}
          >
            {initials}
          </Avatar>
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 700, color: 'text.primary' }}>
              {firstName} {lastName}
            </Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{email}</Typography>
          </Box>
          <Button
            variant="outlined"
            size="small"
            onClick={() => profilePictureInputRef.current?.click()}
            aria-describedby="profile-picture-help"
            sx={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'none',
              borderColor: 'divider',
              color: 'text.secondary',
              '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
            }}
          >
            Change picture
          </Button>
          <input
            ref={profilePictureInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif"
            hidden
            onChange={handleProfilePictureChange}
          />
          <Typography id="profile-picture-help" sx={{ fontSize: 10, color: 'text.secondary' }}>
            JPEG, PNG or GIF, maximum 500 KB.
          </Typography>
        </Paper>

        {/* Main content */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Personal Information */}
          <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.5 }}>
            <Typography component="h2" variant="sectionTitle" sx={sectionTitleSx}>
              Personal information
            </Typography>
            <Grid container spacing={1.5} sx={{ mb: 1.5 }}>
              <Grid size={{ xs: 12, sm: 6 }}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  First name
                </Typography>
                <TextField
                  value={firstName}
                  fullWidth
                  size="small"
                  disabled
                  slotProps={{ htmlInput: { 'aria-label': 'First name' } }}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  Last name
                </Typography>
                <TextField
                  value={lastName}
                  fullWidth
                  size="small"
                  disabled
                  slotProps={{ htmlInput: { 'aria-label': 'Last name' } }}
                />
              </Grid>
              <Grid size={12}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  Email address
                </Typography>
                <TextField
                  value={email}
                  fullWidth
                  size="small"
                  disabled
                  slotProps={{ htmlInput: { 'aria-label': 'Email address' } }}
                />
              </Grid>
            </Grid>
          </Paper>

          {/* Change Password */}
          <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.5 }}>
            <Typography component="h2" variant="sectionTitle" sx={sectionTitleSx}>
              Change password
            </Typography>
            <Box component="form" onSubmit={handlePasswordUpdate} noValidate aria-busy={passwordSubmitting}>
              <Grid container spacing={1.5} sx={{ mb: 1.5 }}>
                <Grid size={12}>
                  <Typography
                    component="label"
                    htmlFor="profile-current-password"
                    variant="fieldLabel"
                    sx={fieldLabelSx}
                  >
                    Current password
                  </Typography>
                  <TextField
                    id="profile-current-password"
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onFocus={markPasswordFormTouched}
                    onChange={(e) => {
                      setCurrentPassword(e.target.value);
                      setPasswordErrors((prev) => ({ ...prev, current: undefined }));
                    }}
                    fullWidth
                    size="small"
                    inputRef={currentPasswordRef}
                    error={Boolean(passwordErrors.current)}
                    helperText={passwordErrors.current}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <Typography component="label" htmlFor="profile-new-password" variant="fieldLabel" sx={fieldLabelSx}>
                    New password
                  </Typography>
                  <TextField
                    id="profile-new-password"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onFocus={markPasswordFormTouched}
                    onChange={(e) => {
                      setNewPassword(e.target.value);
                      setPasswordErrors((prev) => ({ ...prev, next: undefined }));
                    }}
                    placeholder="New password"
                    fullWidth
                    size="small"
                    inputRef={newPasswordRef}
                    error={Boolean(passwordErrors.next)}
                    helperText={passwordErrors.next}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <Typography
                    component="label"
                    htmlFor="profile-confirm-password"
                    variant="fieldLabel"
                    sx={fieldLabelSx}
                  >
                    Confirm new password
                  </Typography>
                  <TextField
                    id="profile-confirm-password"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onFocus={markPasswordFormTouched}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      setPasswordErrors((prev) => ({ ...prev, confirm: undefined }));
                    }}
                    placeholder="Confirm new password"
                    fullWidth
                    size="small"
                    inputRef={confirmPasswordRef}
                    error={Boolean(passwordErrors.confirm)}
                    helperText={passwordErrors.confirm}
                  />
                </Grid>
              </Grid>
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 1.75, borderTop: 1, borderColor: 'divider' }}>
                <Button
                  type="submit"
                  variant="contained"
                  disabled={passwordSubmitting}
                  aria-busy={passwordSubmitting}
                  sx={{ textTransform: 'none', fontWeight: 600 }}
                >
                  {passwordSubmitting ? (
                    <>
                      <CircularProgress size={16} color="inherit" sx={{ mr: 1 }} />
                      Updating…
                    </>
                  ) : (
                    'Update password'
                  )}
                </Button>
              </Box>
            </Box>
          </Paper>

          {/* Notifications */}
          <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.5 }}>
            <Typography component="h2" variant="sectionTitle" sx={sectionTitleSx}>
              Notifications
            </Typography>
            <FormControlLabel
              control={
                <Switch checked={enableEmailNotifications} onChange={handleNotificationToggle} color="secondary" />
              }
              label={
                <Box>
                  <Typography sx={{ fontSize: 13, fontWeight: 600, color: 'text.primary' }}>
                    Email alerts for price changes
                  </Typography>
                  <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                    Get an email when a monitored ticket rises above your limit
                  </Typography>
                </Box>
              }
              labelPlacement="start"
              sx={{ m: 0, pt: 1.5, width: '100%', justifyContent: 'space-between' }}
            />
          </Paper>

          {/* Travel Preferences */}
          <TravelPreferences onDirtyChange={setTravelPreferencesDirty} />

          {/* Your data */}
          <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.5 }}>
            <Typography component="h2" variant="sectionTitle" sx={sectionTitleSx}>
              Your data
            </Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.55, mb: 1.75 }}>
              Download a copy of the personal data stored for your account as a JSON file. How your data is processed is
              explained in the{' '}
              <Link href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
                privacy policy
              </Link>
              .
            </Typography>
            <Button
              variant="outlined"
              onClick={handleExportData}
              disabled={exportingData}
              sx={{ textTransform: 'none', fontWeight: 500 }}
            >
              {exportingData ? 'Preparing download…' : 'Download my data'}
            </Button>
          </Paper>

          {/* Danger Zone */}
          <Paper elevation={0} sx={{ border: 1, borderColor: 'error.main', borderRadius: 3, p: 2.5 }}>
            <Typography
              component="h2"
              variant="sectionTitle"
              sx={{ ...sectionTitleSx, borderColor: 'error.main' }}
              color="error.main"
            >
              Danger zone
            </Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.55, mb: 1.75 }}>
              Permanently delete your account together with your journey monitors, notifications and profile picture.
              This action cannot be undone.
            </Typography>
            <Button
              variant="outlined"
              color="error"
              onClick={handleDeleteAccount}
              sx={{ textTransform: 'none', fontWeight: 500 }}
            >
              Delete my account
            </Button>
          </Paper>
        </Box>
      </Box>

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteConfirmation} onClose={() => setShowDeleteConfirmation(false)}>
        <DialogTitle>Delete Account</DialogTitle>
        <DialogContent>
          <Typography>Are you sure you want to delete your account? This action cannot be undone.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowDeleteConfirmation(false)}>Cancel</Button>
          <Button onClick={handleConfirmDeleteAccount} color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <UnsavedChangesDialog
        open={unsavedChangesBlocked}
        onStay={resetUnsavedChanges}
        onLeave={proceedUnsavedChanges}
        message="Your changes have not been saved. If you leave this page, they will be lost."
      />
    </Box>
  );
};

export default ProfilePage;
