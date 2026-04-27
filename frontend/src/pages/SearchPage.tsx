import React, { useState } from 'react';
import { CircularProgress, Grid, Typography } from '@mui/material';
import SearchMask from '../components/SearchMask';
import SearchResult from '../components/SearchResult';
import { Journey, SearchData } from '../components/SearchResult';

interface Props {}

const SearchPage: React.FC<Props> = () => {
  const [searchData, setSearchData] = useState<SearchData | null>(null);
  const [searchResult, setSearchResult] = useState<Journey[] | undefined>(undefined);
  const [searchClicked, setSearchClicked] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);

  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <Typography variant="h6">Search for Train Rides</Typography>
      </Grid>
      <Grid size={12}>
        <SearchMask
          setSearchData={setSearchData}
          setSearchResult={setSearchResult}
          setLoading={setLoading}
          setSearchClicked={setSearchClicked}
        />
      </Grid>
      <Grid size={12}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100px' }}>
            <CircularProgress />
          </div>
        ) : searchResult !== undefined && searchResult.length > 0 ? (
          <SearchResult searchData={searchData!} searchResult={searchResult} />
        ) : (
          searchClicked && <Typography variant="subtitle1">No results found</Typography>
        )}
      </Grid>
    </Grid>
  );
};

export default SearchPage;
