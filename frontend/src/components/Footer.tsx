import React from 'react';
import { Box, Link, Typography } from '@mui/material';
import { GitHub as GithubIcon } from '@mui/icons-material';

interface Props {}

const Footer: React.FC<Props> = () => {
 return (
    <Box sx={{ bottom: 0, width: '100%', backgroundColor: "primary.main", color: 'white', py: 2, maxWidth: "lg", mx: "auto" }}>
      <Link href="https://github.com/wolfm89/train-price-monitor" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none',color: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <GithubIcon />
          <Typography variant="subtitle1" component="div" sx={{ marginLeft: 1, xs: 'none', md: 'block', color: 'inherit' }}>
              Check out the source on Github
          </Typography>
      </Link>
    </Box>
  );
};

export default Footer;
