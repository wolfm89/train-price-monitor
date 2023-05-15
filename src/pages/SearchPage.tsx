import React from 'react';
import { Container, Typography } from '@mui/material';

interface Props {}

const SearchPage: React.FC<Props> = () => {
  return (
    <Container maxWidth="md" sx={{ my: 4 }} >
        <Typography variant="h4">
        Search
        </Typography>
    </Container>
  );
};

export default SearchPage;

