import React, { useState } from 'react';
import { Typography, Grid, TextField, Button, Avatar, Box } from '@mui/material';

const ProfilePage: React.FC = () => {
  const [firstName, setFirstName] = useState('John');
  const [lastName, setLastName] = useState('Doe');
  const [email, setEmail] = useState('johndoe@example.com');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const handleProfilePictureChange = () => {
    // Logic to handle picture change
  };

  const handleSaveChanges = () => {
    // Handle save changes logic
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
        <Avatar alt="Profile Picture" src="/path/to/profile-picture.jpg" sx={{ width: 120, height: 120 }} />
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
          <Box></Box>
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
