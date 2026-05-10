import React, { ChangeEvent, useContext, useEffect, useState } from 'react';
import {
  Typography,
  Grid,
  TextField,
  Button,
  Avatar,
  Box,
  Switch,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import { AuthContext } from '../providers/AuthProvider';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';
import { changePassword } from '../utils/auth';
import { useMutation, useQuery } from 'urql';
import { DeleteUser, UpdateUserProfilePicture, UpdateUserSettings, UserSettingsQuery } from '../api/user';
import { useNavigate } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const sectionTitleSx = {
  mb: 1.75,
  pb: 1.25,
  borderBottom: 1,
  borderColor: 'divider',
};

const fieldLabelSx = {
  mb: 0.5,
};

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
  const { addAlert } = useAlert();
  const [, updateUserProfilePicture] = useMutation(UpdateUserProfilePicture);
  const [{ data: userSettingsData, fetching: userSettingsFetching }] = useQuery({
    query: UserSettingsQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'] || accountDeletionConfirmed,
  });
  const [, updateUserSettings] = useMutation(UpdateUserSettings);
  const [, deleteUser] = useMutation(DeleteUser);

  useEffect(() => {
    if (userSettingsData) {
      setEnableEmailNotifications(userSettingsData.user?.emailNotificationsEnabled);
    }
  }, [userSettingsData]);

  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
  const allowedMaxSize = 0.5 * 1024 * 1024;

  const handleProfilePictureChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file: File = event.target.files![0];

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
        .then(() => {
          addAlert('Profile picture changed successfully!', AlertSeverity.Success);
          refetchUserProfilePictureUrl();
        })
        .catch(() => {
          addAlert('Profile picture change failed. Please try again.', AlertSeverity.Error);
        });
    }
  };

  const handlePasswordUpdate = async () => {
    if (newPassword !== confirmPassword) {
      addAlert('New passwords do not match.', AlertSeverity.Error);
      return;
    }
    if (currentPassword !== '' && newPassword !== '') {
      try {
        await changePassword(currentPassword, newPassword);
        addAlert('Password changed successfully!', AlertSeverity.Success);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } catch {
        addAlert('Password change failed. Please try again.', AlertSeverity.Error);
      }
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

  const handleConfirmDeleteAccount = async () => {
    setAccountDeletionConfirmed(true);
    deleteUser({ id: user?.['custom:id'] })
      .then(() => {
        deleteCognitoUser()
          .then(() => {
            navigate(`/`);
            addAlert('Account deleted successfully!', AlertSeverity.Success);
          })
          .catch(() => {
            addAlert('Account deletion failed.', AlertSeverity.Error);
          });
      })
      .catch(() => {
        addAlert('Account deletion failed.', AlertSeverity.Error);
      });

    setShowDeleteConfirmation(false);
  };

  const initials = user ? `${user.given_name?.[0] ?? ''}${user.family_name?.[0] ?? ''}`.toUpperCase() : '';

  if (userSettingsFetching) {
    return <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>Loading profile...</Typography>;
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2.5 }}>
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
            component="label"
            size="small"
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
            <input type="file" accept="image/*" hidden onChange={handleProfilePictureChange} />
          </Button>
        </Paper>

        {/* Main content */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Personal Information */}
          <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.5 }}>
            <Typography variant="sectionTitle" sx={sectionTitleSx}>
              Personal information
            </Typography>
            <Grid container spacing={1.5} sx={{ mb: 1.5 }}>
              <Grid size={{ xs: 12, sm: 6 }}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  First name
                </Typography>
                <TextField value={firstName} fullWidth size="small" disabled />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  Last name
                </Typography>
                <TextField value={lastName} fullWidth size="small" disabled />
              </Grid>
              <Grid size={12}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  Email address
                </Typography>
                <TextField value={email} fullWidth size="small" disabled />
              </Grid>
            </Grid>
          </Paper>

          {/* Change Password */}
          <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.5 }}>
            <Typography variant="sectionTitle" sx={sectionTitleSx}>
              Change password
            </Typography>
            <Grid container spacing={1.5} sx={{ mb: 1.5 }}>
              <Grid size={12}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  Current password
                </Typography>
                <TextField
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  fullWidth
                  size="small"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  New password
                </Typography>
                <TextField
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password"
                  fullWidth
                  size="small"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  Confirm new password
                </Typography>
                <TextField
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm"
                  fullWidth
                  size="small"
                />
              </Grid>
            </Grid>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 1.75, borderTop: 1, borderColor: 'divider' }}>
              <Button
                variant="contained"
                onClick={handlePasswordUpdate}
                disabled={!currentPassword || !newPassword || !confirmPassword}
                sx={{ textTransform: 'none', fontWeight: 600 }}
              >
                Update password
              </Button>
            </Box>
          </Paper>

          {/* Notifications */}
          <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.5 }}>
            <Typography variant="sectionTitle" sx={sectionTitleSx}>
              Notifications
            </Typography>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                pt: 1.5,
              }}
            >
              <Box>
                <Typography sx={{ fontSize: 13, fontWeight: 600, color: 'text.primary' }}>
                  Email alerts for price changes
                </Typography>
                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                  Get an email when a monitored ticket rises above your limit
                </Typography>
              </Box>
              <Switch checked={enableEmailNotifications} onChange={handleNotificationToggle} color="secondary" />
            </Box>
          </Paper>

          {/* Danger Zone */}
          <Paper elevation={0} sx={{ border: 1, borderColor: 'error.main', borderRadius: 3, p: 2.5 }}>
            <Typography variant="sectionTitle" sx={{ ...sectionTitleSx, borderColor: 'error.main' }} color="error.main">
              Danger zone
            </Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.55, mb: 1.75 }}>
              Permanently delete your account and all associated journey monitors. This action cannot be undone.
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
    </Box>
  );
};

export default ProfilePage;
