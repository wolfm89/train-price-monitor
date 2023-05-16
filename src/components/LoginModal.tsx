import React from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField } from '@mui/material';

interface Props {
    open: boolean;
    onClose: () => void;
}

const LoginModal: React.FC<Props> = ({ open, onClose }) => {
    const handleLogin = () => {
        // Handle login logic here
        // You can make API calls or perform any necessary operations
        // Once the login is successful, you can close the modal
        console.log("test")
    };

    return (
        <Dialog open={open} onClose={onClose}>
            <DialogTitle>Login</DialogTitle>
            <DialogContent>
                <TextField autoFocus margin="dense" id="email" label="Email" type="text" fullWidth />
                <TextField margin="dense" id="password" label="Password" type="password" fullWidth />
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button onClick={handleLogin} variant="contained" color="primary">
                    Login
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default LoginModal;
