import React from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import VisuallyHidden from './VisuallyHidden';

interface LoadingStatusProps {
  label: string;
  size?: number;
  /** Use when surrounding text already explains the loading state. */
  inline?: boolean;
  minHeight?: number;
}

/**
 * Announces a loading state to assistive technology. The spinner is
 * decorative; the label is the announcement.
 */
export default function LoadingStatus({ label, size = 22, inline = false, minHeight = 100 }: LoadingStatusProps) {
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        minHeight: inline ? undefined : minHeight,
      }}
    >
      <CircularProgress size={size} aria-hidden="true" />
      {inline ? (
        <VisuallyHidden>{label}</VisuallyHidden>
      ) : (
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{label}</Typography>
      )}
    </Box>
  );
}
