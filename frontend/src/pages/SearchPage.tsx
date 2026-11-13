import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Typography } from '@mui/material';
import { useQuery } from 'urql';
import { useSearchParams } from 'react-router-dom';
import SearchMask, { JourneySearchOptions } from '../components/SearchMask';
import SearchResult, { Journey } from '../components/SearchResult';
import { JourneySearchQuery } from '../api/journey';
import { UserTravelPreferencesQuery } from '../api/user';
import { AuthContext } from '../providers/AuthProvider';
import { fromSearchParams, toSearchParams, withPageDirection, SearchQueryVars } from '../utils/searchQueryVars';
import LoadingStatus from '../components/LoadingStatus';

interface Props {}

const SearchPage: React.FC<Props> = () => {
  const { user } = useContext(AuthContext);
  const [searchParams, setSearchParams] = useSearchParams();
  const queryVars = useMemo(() => fromSearchParams(searchParams), [searchParams]);
  const [navigatingDirection, setNavigatingDirection] = useState<'earlier' | 'later' | null>(null);

  // Fetch the user's travel preferences to pre-populate SearchMask
  const [{ data: profileData }] = useQuery({
    query: UserTravelPreferencesQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });

  const queryVariables = useMemo(
    () =>
      queryVars
        ? {
            from: queryVars.from,
            to: queryVars.to,
            departure: queryVars.departure,
            earlierThan: queryVars.earlierThan,
            laterThan: queryVars.laterThan,
            options: queryVars.options,
          }
        : { from: '', to: '', departure: '' },
    [queryVars]
  );

  const [{ data, fetching, error }, reexecuteSearch] = useQuery({
    query: JourneySearchQuery,
    variables: queryVariables,
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

  const handleSearch = (
    from: string,
    to: string,
    departure: string,
    options?: JourneySearchOptions,
    fromName?: string,
    toName?: string
  ) => {
    const next: SearchQueryVars = { from, to, departure, options, fromName, toName };

    // Pressing Search again after a failure submits identical values, and urql does
    // not re-run a query whose variables are unchanged — the button then looked dead
    // until the form was edited. Re-execute explicitly in that case.
    const repeated =
      queryVars !== null &&
      queryVars.from === from &&
      queryVars.to === to &&
      queryVars.departure === departure &&
      JSON.stringify(queryVars.options ?? null) === JSON.stringify(options ?? null);

    const nextParams = toSearchParams(next);
    if (nextParams.toString() === searchParams.toString()) {
      if (repeated) reexecuteSearch({ requestPolicy: 'network-only' });
      return;
    }

    setSearchParams(nextParams, { replace: false });
  };

  const handleNavigateEarlier =
    earlierRef && queryVars
      ? () => {
          setNavigatingDirection('earlier');
          const next = withPageDirection(queryVars, 'earlier', earlierRef);
          if (next) setSearchParams(toSearchParams(next), { replace: false });
        }
      : undefined;

  const handleNavigateLater =
    laterRef && queryVars
      ? () => {
          setNavigatingDirection('later');
          const next = withPageDirection(queryVars, 'later', laterRef);
          if (next) setSearchParams(toSearchParams(next), { replace: false });
        }
      : undefined;

  return (
    <Box>
      <Typography component="h1" variant="h5" sx={{ mb: 0.5 }}>
        Search for train rides
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
        Find a connection and add it to your watchlist.
      </Typography>

      <SearchMask
        isSearching={fetching && !navigatingDirection}
        initialSearch={queryVars}
        onSearch={handleSearch}
        initialWalletCards={profileData?.user?.loyaltyCards}
        initialAgeGroup={profileData?.user?.ageGroup}
        initialDeutschlandTicketDiscount={profileData?.user?.deutschlandTicketDiscount}
      />

      {queryVars &&
        (fetching && !navigatingDirection ? (
          <LoadingStatus label="Searching Deutsche Bahn…" />
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
            <Box aria-busy={fetching}>
              <SearchResult
                searchResult={searchResult ?? []}
                searchOptions={queryVars.options}
                onNavigateEarlier={handleNavigateEarlier}
                onNavigateLater={handleNavigateLater}
                navigatingDirection={navigatingDirection}
              />
            </Box>
          ) : (
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>No results found</Typography>
          )
        ) : null)}
    </Box>
  );
};

export default SearchPage;
