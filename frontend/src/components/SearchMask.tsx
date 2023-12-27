import React, { useCallback, useEffect, useState } from 'react';
import { Button, TextField, Grid, Typography, Autocomplete } from '@mui/material';
import { useQuery } from 'urql';
import debounce from 'lodash/debounce';
import { JourneySearchQuery } from '../api/journey';
import { LocationSearchQuery } from '../api/location';

interface Props {
  setSearchData: (searchData: any) => void;
  setSearchResult: (searchResult: any) => void;
  setLoading: (loading: boolean) => void;
  setSearchClicked: (searchClicked: boolean) => void;
}

interface Location {
  id: string;
  name: string;
}

const SearchMask: React.FC<Props> = ({ setSearchData, setSearchResult, setLoading, setSearchClicked }) => {
  const [from, setFrom] = useState<Location | null>(null);
  const [fromInput, setFromInput] = useState<string>('');
  const [fromSuggestions, setFromSuggestions] = useState<readonly Location[]>([]);

  const [to, setTo] = useState<Location | null>(null);
  const [toInput, setToInput] = useState<string>('');
  const [toSuggestions, setToSuggestions] = useState<readonly Location[]>([]);

  const [departureDay, setDepartureDay] = useState<string>('');
  const [departureTime, setDepartureTime] = useState<string>('');
  const [formValid, setFormValid] = useState<boolean>(false);

  const [{ data: fromData, fetching: fromFetching }, reexecuteFromSearchQuery] = useQuery({
    query: LocationSearchQuery,
    variables: {
      query: fromInput.trim(),
    },
    pause: true,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getFromSuggestionsDelayed = useCallback(
    debounce(() => {
      reexecuteFromSearchQuery({ requestPolicy: 'network-only' });
    }, 250),
    [reexecuteFromSearchQuery]
  );
  const [{ data: toData, fetching: toFetching }, reexecuteToSearchQuery] = useQuery({
    query: LocationSearchQuery,
    variables: {
      query: toInput.trim(),
    },
    pause: true,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getToSuggestionsDelayed = useCallback(
    debounce(() => {
      reexecuteToSearchQuery({ requestPolicy: 'network-only' });
    }, 250),
    [reexecuteToSearchQuery]
  );
  const [{ data, fetching }, reexecuteJourneySearchQuery] = useQuery({
    query: JourneySearchQuery,
    variables: {
      from: from?.id,
      to: to?.id,
      departure: `${formValid ? createISODateString(departureDay.trim(), departureTime.trim()) : ''}`,
    },
    pause: true,
  });

  useEffect(() => {
    setSearchResult(data?.journeys);
    setLoading(fetching);
  }, [data, fetching, setLoading, setSearchResult]);

  useEffect(() => {
    if (fromInput === '') {
      return undefined;
    }
    setFromSuggestions([]);
    getFromSuggestionsDelayed();
  }, [from, fromInput, getFromSuggestionsDelayed]);

  useEffect(() => {
    if (fromData) {
      setFromSuggestions(fromData.locations);
    }
  }, [fromData]);

  useEffect(() => {
    if (toInput === '') {
      return undefined;
    }
    setToSuggestions([]);
    getToSuggestionsDelayed();
  }, [to, toInput, getToSuggestionsDelayed]);

  useEffect(() => {
    if (toData) {
      setToSuggestions(toData.locations);
    }
  }, [toData]);

  function createISODateString(day: string, time: string): string {
    const [year, month, date] = day.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);

    const dateObject = new Date(year, month - 1, date, hours, minutes);

    return dateObject.toISOString();
  }

  const handleSearchClick = () => {
    setSearchClicked(true);
    setLoading(true);
    setSearchData({
      departure: from?.name,
      destination: to?.name,
      date: departureDay,
      time: departureTime,
    });
    reexecuteJourneySearchQuery({ requestPolicy: 'network-only' });
  };

  // Update form validity based on input fields
  React.useEffect(() => {
    setFormValid(from?.id !== '' && to?.id !== '' && departureDay.trim() !== '' && departureTime.trim() !== '');
  }, [from, to, departureDay, departureTime]);

  return (
    <Grid container spacing={2}>
      <Grid item xs={3} sm={1} container justifyContent="flex-end" alignItems="center">
        <Typography>From:</Typography>
      </Grid>
      <Grid item xs={9} sm={5}>
        <Autocomplete
          id="departure"
          value={from}
          filterOptions={(x) => x}
          options={fromSuggestions}
          getOptionLabel={(option) => option.name}
          autoComplete
          includeInputInList
          filterSelectedOptions
          noOptionsText="No locations found"
          loading={fromFetching}
          renderInput={(params) => <TextField {...params} label="Station" fullWidth />}
          isOptionEqualToValue={(option: Location, value: Location) => option.id === value.id}
          onChange={(_event: any, newValue: Location | null) => {
            setFromSuggestions(newValue ? [newValue, ...fromSuggestions] : fromSuggestions);
            setFrom(newValue);
          }}
          onInputChange={(_event, newInputValue) => {
            setFromInput(newInputValue);
          }}
        />
      </Grid>
      <Grid item xs={3} sm={1} container justifyContent="flex-end" alignItems="center">
        <Typography>To:</Typography>
      </Grid>
      <Grid item xs={9} sm={5}>
        <Autocomplete
          id="departure"
          value={to}
          filterOptions={(x) => x}
          options={toSuggestions}
          getOptionLabel={(option) => option.name}
          autoComplete
          includeInputInList
          filterSelectedOptions
          noOptionsText="No locations found"
          loading={toFetching}
          renderInput={(params) => <TextField {...params} label="Station" fullWidth />}
          isOptionEqualToValue={(option: Location, value: Location) => option.id === value.id}
          onChange={(_event: any, newValue: Location | null) => {
            setToSuggestions(newValue ? [newValue, ...toSuggestions] : toSuggestions);
            setTo(newValue);
          }}
          onInputChange={(_event, newInputValue) => {
            setToInput(newInputValue);
          }}
        />
      </Grid>
      <Grid item xs={3} sm={1} container justifyContent="flex-end" alignItems="center">
        <Typography>Departure:</Typography>
      </Grid>
      <Grid item xs={5} sm={3}>
        <TextField
          id="date"
          type="date"
          value={departureDay}
          onChange={(e) => setDepartureDay(e.target.value)}
          fullWidth
        />
      </Grid>
      <Grid item xs={4} sm={2}>
        <TextField
          id="time"
          type="time"
          value={departureTime}
          onChange={(e) => setDepartureTime(e.target.value)}
          fullWidth
          inputProps={{
            style: { textAlign: 'right' },
          }}
        />
      </Grid>
      <Grid item sm={6} container justifyContent="right" alignItems="center">
        <Button variant="contained" type="submit" disabled={!formValid} onClick={handleSearchClick}>
          Search
        </Button>
      </Grid>
    </Grid>
  );
};

export default SearchMask;
