import React from 'react';
import { Box } from '@mui/material';

interface VisuallyHiddenProps {
  children: React.ReactNode;
}

/**
 * Hides content visually while keeping it available to assistive technology.
 * Used for status text, skip links and labels that are only meaningful to a
 * screen reader.
 */
export default function VisuallyHidden({ children }: VisuallyHiddenProps) {
  return (
    <Box
      component="span"
      sx={{
        border: 0,
        clip: 'rect(0 0 0 0)',
        height: '1px',
        margin: '-1px',
        overflow: 'hidden',
        padding: 0,
        position: 'absolute',
        whiteSpace: 'nowrap',
        width: '1px',
      }}
    >
      {children}
    </Box>
  );
}
