import React, { useContext, useState } from 'react';
import { Typography, Grid, TextField, Button, Avatar, Box } from '@mui/material';
import { AuthContext } from '../providers/AuthProvider';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';
import { changePassword } from '../utils/auth';
import { useMutation } from 'urql';
import { UpdateUserProfilePicture } from '../api/user';

const ProfilePage: React.FC = () => {
  const { user, userProfilePictureUrl, refetchUserProfilePictureUrl } = useContext(AuthContext);
  const [firstName, setFirstName] = useState(user?.given_name);
  const [lastName, setLastName] = useState(user?.family_name);
  const [email, setEmail] = useState(user?.email);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const { addAlert } = useAlert();
  const [, updateUserProfilePicture] = useMutation(UpdateUserProfilePicture);

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
        .then((result) => {
          addAlert('Profile picture changed successfully!', AlertSeverity.Success);
          refetchUserProfilePictureUrl();
        })
        .catch((error) => {
          addAlert('Profile picture change failed. Please try again.', AlertSeverity.Error);
        });
    }
  };

  const handleSaveChanges = async () => {
    try {
      await changePassword(oldPassword, newPassword);
      addAlert('Password changed successfully!', AlertSeverity.Success);
    } catch (error) {
      addAlert('Password change failed. Please try again.', AlertSeverity.Error);
    }
  };

  return (
    <>
      <Typography variant="h6" gutterBottom>
        Profile
      </Typography>
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
          <Button variant="contained" color="primary" onClick={handleSaveChanges}>
            Save Changes
          </Button>
        </Grid>
      </Grid>
    </>
  );
};

export default ProfilePage;
