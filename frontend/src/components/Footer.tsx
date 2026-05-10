import React from 'react';
import { Box, Link, Typography } from '@mui/material';
import { GitHub as GithubIcon } from '@mui/icons-material';

interface Props {}

const Footer: React.FC<Props> = () => {
  return (
    <Box
      sx={{
        borderTop: 1,
        borderColor: 'divider',
        py: 1.25,
        px: 3,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
      }}
    >
      <Link
        href="https://github.com/wolfm89/train-price-monitor"
        target="_blank"
        rel="noopener noreferrer"
        sx={{
          textDecoration: 'none',
          color: 'text.disabled',
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          fontSize: 11,
          borderRadius: 1,
          px: 0.75,
          py: 0.5,
          transition: 'color 0.15s',
          '&:hover': { color: 'text.primary' },
        }}
      >
        <GithubIcon sx={{ fontSize: 14 }} />
        <Typography component="span" sx={{ fontSize: 11 }}>
          Source on GitHub
        </Typography>
      </Link>
    </Box>
  );
};

export default Footer;
