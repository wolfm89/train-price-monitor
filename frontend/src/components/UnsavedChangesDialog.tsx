import React from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';

interface UnsavedChangesDialogProps {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
  title?: string;
  message?: string;
}

export default function UnsavedChangesDialog({
  open,
  onStay,
  onLeave,
  title = 'Discard changes?',
  message = 'You have unsaved changes. If you leave this page, your changes will be lost.',
}: UnsavedChangesDialogProps) {
  return (
    <Dialog open={open} onClose={onStay} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{message}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onStay}>Stay</Button>
        <Button onClick={onLeave} color="error" variant="contained">
          Leave
        </Button>
      </DialogActions>
    </Dialog>
  );
}
