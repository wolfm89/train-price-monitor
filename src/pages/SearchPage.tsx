import React, { useState } from 'react';
import { Container, Grid, Typography } from '@mui/material';
import SearchMask from '../components/SearchMask';
import SearchResult from '../components/SearchResult';

interface Props {}

const SearchPage: React.FC<Props> = () => {
  const [searchClicked, setSearchClicked] = useState<boolean>(false);
  const [searchData, setSearchData] = useState<any>(null);
  const [searchResult, setSearchResult] = useState<any>(null);

  const handleSearchClick = (searchData: any, searchResult: any) => {
    // Perform search logic here
    // You can make API calls or perform any necessary operations based on the input values
    // Update the state or perform any desired actions
    setSearchData(searchData);
    setSearchResult(searchResult);
    setSearchClicked(true);
  };

  return (
    <Container maxWidth="md" sx={{ my: 4 }}>
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <Typography variant="h6">Search for Train Rides</Typography>
        </Grid>
        <Grid item xs={12}>
          <SearchMask onSearch={handleSearchClick} />
        </Grid>
        {searchClicked && (
          <Grid item xs={12}>
            <SearchResult searchData={searchData} searchResult={searchResult} />
          </Grid>
        )}
      </Grid>
    </Container>
  );
};

export default SearchPage;
