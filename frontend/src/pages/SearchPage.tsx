import React, { useContext, useEffect, useState } from 'react';
import { Alert, Box, CircularProgress, Typography } from '@mui/material';
import { useQuery } from 'urql';
import SearchMask from '../components/SearchMask';
import { JourneySearchOptions } from '../components/SearchMask';
import SearchResult from '../components/SearchResult';
import { Journey, SearchData } from '../components/SearchResult';
import { JourneySearchQuery } from '../api/journey';
import { UserTravelPreferencesQuery } from '../api/user';
import { AuthContext } from '../providers/AuthProvider';

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
  const { user } = useContext(AuthContext);
  const [searchData, setSearchData] = useState<SearchData | null>(null);
  const [queryVars, setQueryVars] = useState<QueryVars | null>(null);
  const [searchClicked, setSearchClicked] = useState<boolean>(false);
  const [navigatingDirection, setNavigatingDirection] = useState<'earlier' | 'later' | null>(null);
  const [searchOptions, setSearchOptions] = useState<JourneySearchOptions | undefined>(undefined);

  // Fetch the user's travel preferences to pre-populate SearchMask
  const [{ data: profileData }] = useQuery({
    query: UserTravelPreferencesQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });

  const [{ data, fetching, error }, reexecuteSearch] = useQuery({
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

    // Pressing Search again after a failure submits identical values, and urql does
    // not re-run a query whose variables are unchanged — the button then looked dead
    // until the form was edited. Re-execute explicitly in that case.
    const repeated =
      queryVars !== null &&
      queryVars.from === from &&
      queryVars.to === to &&
      queryVars.departure === departure &&
      JSON.stringify(queryVars.options ?? null) === JSON.stringify(options ?? null);

    setQueryVars({ from, to, departure, options });

    if (repeated) {
      reexecuteSearch({ requestPolicy: 'network-only' });
    }
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

      <SearchMask
        setSearchData={setSearchData}
        onSearch={handleSearch}
        initialWalletCards={profileData?.user?.loyaltyCards}
        initialAgeGroup={profileData?.user?.ageGroup}
        initialDeutschlandTicketDiscount={profileData?.user?.deutschlandTicketDiscount}
      />

      {searchClicked &&
        (fetching && !navigatingDirection ? (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1.5, height: 100 }}>
            <CircularProgress size={22} />
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>Searching Deutsche Bahn…</Typography>
          </Box>
        ) : error ? (
          // A failed lookup used to render as "No results found", because the
          // resolver returns `journeys: null` when the upstream call fails. Say
          // what actually happened so the user retries instead of concluding the
          // connection does not exist.
          <Alert severity="error" sx={{ fontSize: 13 }}>
            The search could not be completed. Please try again in a moment.
          </Alert>
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
