import React, { useState } from 'react';
import { CircularProgress, Grid, Typography } from '@mui/material';
import { useQuery } from 'urql';
import SearchMask from '../components/SearchMask';
import SearchResult from '../components/SearchResult';
import { Journey, SearchData } from '../components/SearchResult';
import { JourneySearchQuery } from '../api/journey';

interface QueryVars {
  from: string;
  to: string;
  departure: string;
  earlierThan?: string;
  laterThan?: string;
}

interface Props {}

const SearchPage: React.FC<Props> = () => {
  const [searchData, setSearchData] = useState<SearchData | null>(null);
  const [queryVars, setQueryVars] = useState<QueryVars | null>(null);
  const [searchClicked, setSearchClicked] = useState<boolean>(false);

  const [{ data, fetching }] = useQuery({
    query: JourneySearchQuery,
    variables: queryVars ?? { from: '', to: '', departure: '' },
    pause: !queryVars,
    requestPolicy: 'network-only',
  });

  const searchResult: Journey[] | undefined = data?.journeys?.journeys ?? undefined;
  const earlierRef: string | undefined = data?.journeys?.earlierRef ?? undefined;
  const laterRef: string | undefined = data?.journeys?.laterRef ?? undefined;

  const handleSearch = (from: string, to: string, departure: string) => {
    setSearchClicked(true);
    setQueryVars({ from, to, departure });
  };

  const handleNavigateEarlier = earlierRef
    ? () => setQueryVars((prev) => ({ ...prev!, earlierThan: earlierRef, laterThan: undefined }))
    : undefined;

  const handleNavigateLater = laterRef
    ? () => setQueryVars((prev) => ({ ...prev!, laterThan: laterRef, earlierThan: undefined }))
    : undefined;

  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <Typography variant="h6">Search for Train Rides</Typography>
      </Grid>
      <Grid size={12}>
        <SearchMask setSearchData={setSearchData} onSearch={handleSearch} />
      </Grid>
      <Grid size={12}>
        {searchClicked &&
          (fetching && !data ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100px' }}>
              <CircularProgress />
            </div>
          ) : data !== undefined ? (
            (searchResult ?? []).length > 0 || fetching || earlierRef || laterRef ? (
              <SearchResult
                searchData={searchData!}
                searchResult={searchResult ?? []}
                onNavigateEarlier={handleNavigateEarlier}
                onNavigateLater={handleNavigateLater}
                navigating={fetching}
              />
            ) : (
              <Typography variant="subtitle1">No results found</Typography>
            )
          ) : null)}
      </Grid>
    </Grid>
  );
};

export default SearchPage;
