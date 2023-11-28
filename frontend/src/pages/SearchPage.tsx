import React, { useState } from 'react';
import { Grid, Typography } from '@mui/material';
import SearchMask from '../components/SearchMask';
import SearchResult from '../components/SearchResult';

interface Props {}

const SearchPage: React.FC<Props> = () => {
  const [searchData, setSearchData] = useState<any>(null);
  const [searchResult, setSearchResult] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const handleSearchClick = (searchData: any, searchResult: any) => {
    // Perform search logic here
    // You can make API calls or perform any necessary operations based on the input values
    // Update the state or perform any desired actions
    setSearchData(searchData);
    setSearchResult(searchResult);
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
        <Typography variant="h6">Search for Train Rides</Typography>
      </Grid>
      <Grid item xs={12}>
        <SearchMask onSearch={handleSearchClick} setLoading={setLoading} />
      </Grid>
      <Grid item xs={12}>
        <SearchResult searchData={searchData} searchResult={searchResult} loading={loading} />
      </Grid>
    </Grid>
  );
};

export default SearchPage;
