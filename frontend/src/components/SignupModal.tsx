import { Button, Dialog, DialogTitle, DialogContent, DialogActions, TextField } from '@mui/material';
import React, { useState } from 'react';

interface Props {
    open: boolean;
    onClose: () => void;
}

const SignupModal: React.FC<Props> = ({ open, onClose }) => {
    const [email, setEmail] = useState<string>('');
    const [password, setPassword] = useState<string>('');

    const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setEmail(e.target.value);
    };

    const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPassword(e.target.value);
    };

    const handleSignUp = () => {
        // Add your sign-up logic here
    };

    return (
        <Dialog open={open} onClose={onClose}>
            <DialogTitle>Sign Up</DialogTitle>
            <DialogContent>
                <TextField autoFocus margin="dense" id="firstName" label="First Name" type="text" fullWidth />
                <TextField margin="dense" id="lastName" label="Last Name" type="text" fullWidth />
                <TextField margin="dense" label="Email" type="email" fullWidth value={email} onChange={handleEmailChange} />
                <TextField margin="dense" label="Password" type="password" fullWidth value={password} onChange={handlePasswordChange} />
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button onClick={handleSignUp} color="primary">Sign Up</Button>
            </DialogActions>
        </Dialog>
    );
};

export default SignupModal;
