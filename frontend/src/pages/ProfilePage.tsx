import React, { ChangeEvent, useContext, useEffect, useState } from 'react';
import {
  Typography,
  Grid,
  TextField,
  Button,
  Avatar,
  Box,
  Checkbox,
  FormControlLabel,
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

const ProfilePage: React.FC = () => {
  const { user, userProfilePictureUrl, refetchUserProfilePictureUrl } = useContext(AuthContext);
  const [firstName, setFirstName] = useState(user?.given_name);
  const [lastName, setLastName] = useState(user?.family_name);
  const [email, setEmail] = useState(user?.email);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [enableEmailNotifications, setEnableEmailNotifications] = useState(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false); // State to control the visibility of the delete confirmation dialog
  const { addAlert } = useAlert();
  const [, updateUserProfilePicture] = useMutation(UpdateUserProfilePicture);
  const [{ data: userSettingsData, fetching: userSettingsFetching }] = useQuery({
    query: UserSettingsQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });
  const [, updateUserSettings] = useMutation(UpdateUserSettings);
  const [, deleteUser] = useMutation(DeleteUser);

  useEffect(() => {
    if (userSettingsData) {
      setEnableEmailNotifications(userSettingsData.user?.emailNotificationsEnabled);
    }
  }, [userSettingsData]);

  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
  const allowedMaxSize = 0.5 * 1024 * 1024; // 0.5 MB

  const handleProfilePictureChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file: File = event.target.files![0]; // Get the first selected file

    // Perform any desired actions with the file
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

  const handleSaveChanges = async () => {
    // Only if password was changed
    if (oldPassword !== '' && newPassword !== '') {
      try {
        await changePassword(oldPassword, newPassword);
        addAlert('Password changed successfully!', AlertSeverity.Success);
      } catch (error) {
        addAlert('Password change failed. Please try again.', AlertSeverity.Error);
      }
    }
    // Only if email notifications setting was changed
    if (enableEmailNotifications !== userSettingsData?.user?.emailNotificationsEnabled) {
      updateUserSettings({ id: user?.['custom:id'], emailNotificationsEnabled: enableEmailNotifications }).then(
        (result) => {
          if (result.error) {
            addAlert('Updating user settings failed. Please try again.', AlertSeverity.Error);
          } else {
            addAlert('User settings updated successfully!', AlertSeverity.Success);
          }
        }
      );
    }
  };

  const handleEmailNoficationsEnabledChange = (_event: ChangeEvent<HTMLInputElement>, checked: boolean) => {
    setEnableEmailNotifications(checked);
  };

  const handleDeleteAccount = async () => {
    // Show confirmation dialog
    setShowDeleteConfirmation(true);
  };

  const handleConfirmDeleteAccount = async () => {
    // Delete the account
    deleteUser({ id: user?.['custom:id'] })
      .then(() => {
        addAlert('Account deleted successfully!', AlertSeverity.Success);
      })
      .catch(() => {
        addAlert('Account deletion failed.', AlertSeverity.Error);
      });

    // Hide the confirmation dialog
    setShowDeleteConfirmation(false);
  };

  const handleCancelDeleteAccount = () => {
    // Hide the confirmation dialog
    setShowDeleteConfirmation(false);
  };

  return (
    <>
      <Typography variant="h6" gutterBottom>
        Profile
      </Typography>
      {userSettingsFetching ? (
        <Typography variant="body1">Loading profile...</Typography>
      ) : (
        <>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'left',
              alignItems: 'center',
              marginBottom: 4,
            }}
          >
            <Avatar alt="Profile Picture" src={userProfilePictureUrl} sx={{ width: 120, height: 120 }} />
            <Box sx={{ flexGrow: 0, marginLeft: 2 }}>
              <Button variant="outlined" component="label">
                Change Picture
                <input type="file" accept="image/*" hidden onChange={handleProfilePictureChange} />
              </Button>
            </Box>
          </Box>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField
                label="First Name"
                variant="outlined"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                fullWidth
                disabled
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                label="Last Name"
                variant="outlined"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                fullWidth
                disabled
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                label="Email"
                variant="outlined"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                fullWidth
                disabled
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <Box />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                id="oldPassword"
                label="Old Password"
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                id="newPassword"
                label="New Password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid item xs={12}>
              <FormControlLabel
                control={<Checkbox checked={enableEmailNotifications} onChange={handleEmailNoficationsEnabledChange} />}
                label="Enable Email Notifications for Price Alerts"
              />
            </Grid>
            <Grid item xs={6}>
              <Button variant="contained" color="primary" onClick={handleSaveChanges}>
                Save Changes
              </Button>
            </Grid>
            <Grid item xs={6} sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="contained" color="error" onClick={handleDeleteAccount}>
                Delete Account
              </Button>
            </Grid>
          </Grid>
          {/* Confirmation Dialog */}
          <Dialog open={showDeleteConfirmation} onClose={handleCancelDeleteAccount}>
            <DialogTitle>Delete Account</DialogTitle>
            <DialogContent>
              <Typography>Are you sure you want to delete your account?</Typography>
            </DialogContent>
            <DialogActions>
              <Button onClick={handleCancelDeleteAccount}>Cancel</Button>
              <Button onClick={handleConfirmDeleteAccount} color="error">
                Delete
              </Button>
            </DialogActions>
          </Dialog>
        </>
      )}
    </>
  );
};

export default ProfilePage;
