import React, { useState } from 'react';
import { CircularProgress, Grid, Typography } from '@mui/material';
import SearchMask from '../components/SearchMask';
import SearchResult from '../components/SearchResult';

interface Props {}

const SearchPage: React.FC<Props> = () => {
  const [searchData, setSearchData] = useState<any>(null);
  const [searchResult, setSearchResult] = useState<any>(null);
  const [searchClicked, setSearchClicked] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
        <Typography variant="h6">Search for Train Rides</Typography>
      </Grid>
      <Grid item xs={12}>
        <SearchMask
          setSearchData={setSearchData}
          setSearchResult={setSearchResult}
          setLoading={setLoading}
          setSearchClicked={setSearchClicked}
        />
      </Grid>
      <Grid item xs={12}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100px' }}>
            <CircularProgress />
          </div>
        ) : searchResult ?? false ? (
          <SearchResult searchData={searchData} searchResult={searchResult} />
        ) : (
          searchClicked && <Typography variant="subtitle1">No results found</Typography>
        )}
      </Grid>
    </Grid>
  );
};

export default SearchPage;
