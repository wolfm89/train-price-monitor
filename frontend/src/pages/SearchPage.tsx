import React, { useEffect, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { useQuery } from 'urql';
import SearchMask from '../components/SearchMask';
import { JourneySearchOptions } from '../components/SearchMask';
import SearchResult from '../components/SearchResult';
import { Journey, SearchData } from '../components/SearchResult';
import { JourneySearchQuery } from '../api/journey';

interface QueryVars {
  from: string;
  to: string;
  departure: string;
  earlierThan?: string;
  laterThan?: string;
  options?: JourneySearchOptions;
}

interface Props {}

const SearchPage: React.FC<Props> = () => {
  const [searchData, setSearchData] = useState<SearchData | null>(null);
  const [queryVars, setQueryVars] = useState<QueryVars | null>(null);
  const [searchClicked, setSearchClicked] = useState<boolean>(false);
  const [navigatingDirection, setNavigatingDirection] = useState<'earlier' | 'later' | null>(null);
  const [searchOptions, setSearchOptions] = useState<JourneySearchOptions | undefined>(undefined);

  const [{ data, fetching }] = useQuery({
    query: JourneySearchQuery,
    variables: queryVars ?? { from: '', to: '', departure: '' },
    pause: !queryVars,
    requestPolicy: 'network-only',
  });

  const searchResult: Journey[] | undefined = data?.journeys?.journeys ?? undefined;
  const earlierRef: string | undefined = data?.journeys?.earlierRef ?? undefined;
  const laterRef: string | undefined = data?.journeys?.laterRef ?? undefined;

  useEffect(() => {
    if (!fetching) {
      setNavigatingDirection(null);
    }
  }, [fetching]);

  const handleSearch = (from: string, to: string, departure: string, options?: JourneySearchOptions) => {
    setSearchClicked(true);
    setSearchOptions(options);
    setQueryVars({ from, to, departure, options });
  };

  const handleNavigateEarlier = earlierRef
    ? () => {
        setNavigatingDirection('earlier');
        setQueryVars((prev) => ({ ...prev!, earlierThan: earlierRef, laterThan: undefined }));
      }
    : undefined;

  const handleNavigateLater = laterRef
    ? () => {
        setNavigatingDirection('later');
        setQueryVars((prev) => ({ ...prev!, laterThan: laterRef, earlierThan: undefined }));
      }
    : undefined;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        Search for train rides
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
        Find a connection and add it to your watchlist.
      </Typography>

      <SearchMask setSearchData={setSearchData} onSearch={handleSearch} />

      {searchClicked &&
        (fetching && !data ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 100 }}>
            <CircularProgress />
          </Box>
        ) : data !== undefined ? (
          (searchResult ?? []).length > 0 || fetching || earlierRef || laterRef ? (
            <SearchResult
              searchData={searchData!}
              searchResult={searchResult ?? []}
              searchOptions={searchOptions}
              onNavigateEarlier={handleNavigateEarlier}
              onNavigateLater={handleNavigateLater}
              navigatingDirection={navigatingDirection}
            />
          ) : (
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>No results found</Typography>
          )
        ) : null)}
    </Box>
  );
};

export default SearchPage;
