import React from 'react';
import { Box, Link, Typography } from '@mui/material';
import { GitHub as GithubIcon } from '@mui/icons-material';
import { LEGAL_NOTICE_URL, PRIVACY_POLICY_URL } from '../utils/legalLinks';

const footerLinkSx = {
  textDecoration: 'none',
  color: 'text.secondary',
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
  fontSize: 11,
  borderRadius: 1,
  px: 0.75,
  py: 0.5,
  transition: 'color 0.15s',
  '&:hover': { color: 'text.primary' },
};

interface Props {}

const Footer: React.FC<Props> = () => {
  return (
    <Box
      component="footer"
      sx={{
        borderTop: 1,
        borderColor: 'divider',
        py: 1.25,
        px: 3,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        gap: 0.5,
        flexShrink: 0,
      }}
    >
      <Link href="https://wolfgangmoser.eu/" sx={footerLinkSx}>
        Wolfgang Moser
      </Link>
      <Link href={LEGAL_NOTICE_URL} sx={footerLinkSx}>
        Legal notice
      </Link>
      <Link href={PRIVACY_POLICY_URL} sx={footerLinkSx}>
        Privacy policy
      </Link>
      <Link
        href="https://github.com/wolfm89/train-price-monitor"
        target="_blank"
        rel="noopener noreferrer"
        sx={footerLinkSx}
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
