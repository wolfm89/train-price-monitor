import React, { useCallback, useEffect, useState } from 'react';
import { Button, TextField, Grid, Typography, Autocomplete, Paper, Box, InputAdornment } from '@mui/material';
import {
  Search as SearchIcon,
  LocationOn as LocationOnIcon,
  CalendarToday as CalendarTodayIcon,
  AccessTime as AccessTimeIcon,
} from '@mui/icons-material';
import { useQuery } from 'urql';
import debounce from 'lodash/debounce';
import { LocationSearchQuery } from '../api/location';
import { SearchData } from './SearchResult';

interface Props {
  setSearchData: (searchData: SearchData) => void;
  onSearch: (from: string, to: string, departure: string) => void;
}

interface Location {
  id: string;
  name: string;
}

const fieldLabelSx = {
  mb: 0.5,
};

const SearchMask: React.FC<Props> = ({ setSearchData, onSearch }) => {
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
  const getToSuggestionsDelayed = useCallback(
    debounce(() => {
      reexecuteToSearchQuery({ requestPolicy: 'network-only' });
    }, 250),
    [reexecuteToSearchQuery]
  );

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

  function createDateFromDayAndTime(day: string, time: string) {
    const [year, month, date] = day.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);

    return new Date(year, month - 1, date, hours, minutes);
  }

  function createISODateString(day: string, time: string): string {
    return createDateFromDayAndTime(day, time).toISOString();
  }

  const handleSearchClick = () => {
    setSearchData({
      departure: from?.name ?? '',
      destination: to?.name ?? '',
      date: departureDay,
      time: departureTime,
    });
    onSearch(from?.id ?? '', to?.id ?? '', createISODateString(departureDay.trim(), departureTime.trim()));
  };

  React.useEffect(() => {
    const day = departureDay.trim();
    const time = departureTime.trim();
    setFormValid(
      from?.id !== '' &&
        to?.id !== '' &&
        day !== '' &&
        time !== '' &&
        createDateFromDayAndTime(departureDay, departureTime) > new Date()
    );
  }, [from, to, departureDay, departureTime]);

  return (
    <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.75, mb: 2.75 }}>
      <Grid container spacing={1.75} sx={{ mb: 1.75 }}>
        <Grid size={{ xs: 12, sm: 6 }}>
          <Typography variant="fieldLabel" sx={fieldLabelSx}>
            From
          </Typography>
          <Autocomplete
            id="departure"
            value={from}
            options={fromSuggestions ?? []}
            filterOptions={(x) => x}
            getOptionLabel={(option) => option?.name ?? ''}
            includeInputInList
            filterSelectedOptions
            noOptionsText="No locations found"
            loading={fromFetching}
            size="small"
            renderInput={(params) => (
              <TextField
                {...params}
                placeholder="Station"
                fullWidth
                inputProps={{
                  ...params.inputProps,
                  'aria-label': 'From station',
                }}
                slotProps={{
                  input: {
                    ...params.InputProps,
                    startAdornment: (
                      <>
                        <InputAdornment position="start">
                          <LocationOnIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
                        </InputAdornment>
                        {params.InputProps.startAdornment}
                      </>
                    ),
                  },
                }}
              />
            )}
            isOptionEqualToValue={(option: Location, value: Location) => option?.id === value?.id}
            onChange={(_event: React.SyntheticEvent, newValue: Location | null) => {
              setFromSuggestions(newValue ? [newValue, ...(fromSuggestions ?? [])] : fromSuggestions ?? []);
              setFrom(newValue);
            }}
            onInputChange={(_event, newInputValue) => {
              setFromInput(newInputValue);
            }}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6 }}>
          <Typography variant="fieldLabel" sx={fieldLabelSx}>
            To
          </Typography>
          <Autocomplete
            id="arrival"
            value={to}
            options={toSuggestions ?? []}
            filterOptions={(x) => x}
            getOptionLabel={(option) => option?.name ?? ''}
            includeInputInList
            filterSelectedOptions
            noOptionsText="No locations found"
            loading={toFetching}
            size="small"
            renderInput={(params) => (
              <TextField
                {...params}
                placeholder="Station"
                fullWidth
                inputProps={{
                  ...params.inputProps,
                  'aria-label': 'To station',
                }}
                slotProps={{
                  input: {
                    ...params.InputProps,
                    startAdornment: (
                      <>
                        <InputAdornment position="start">
                          <LocationOnIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
                        </InputAdornment>
                        {params.InputProps.startAdornment}
                      </>
                    ),
                  },
                }}
              />
            )}
            isOptionEqualToValue={(option: Location, value: Location) => option?.id === value?.id}
            onChange={(_event: React.SyntheticEvent, newValue: Location | null) => {
              setToSuggestions(newValue ? [newValue, ...(toSuggestions ?? [])] : toSuggestions ?? []);
              setTo(newValue);
            }}
            onInputChange={(_event, newInputValue) => {
              setToInput(newInputValue);
            }}
          />
        </Grid>
      </Grid>
      <Box
        sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 130px auto' }, gap: 1.5, alignItems: 'end' }}
      >
        <Box>
          <Typography variant="fieldLabel" sx={fieldLabelSx}>
            Departure date
          </Typography>
          <TextField
            id="date"
            type="date"
            value={departureDay}
            onChange={(e) => setDepartureDay(e.target.value)}
            fullWidth
            size="small"
            slotProps={{
              htmlInput: { 'aria-label': 'Departure date' },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <CalendarTodayIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                  </InputAdornment>
                ),
              },
            }}
          />
        </Box>
        <Box>
          <Typography variant="fieldLabel" sx={fieldLabelSx}>
            Time
          </Typography>
          <TextField
            id="time"
            type="time"
            value={departureTime}
            onChange={(e) => setDepartureTime(e.target.value)}
            fullWidth
            slotProps={{
              htmlInput: { 'aria-label': 'Departure time' },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <AccessTimeIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                  </InputAdornment>
                ),
              },
            }}
            size="small"
          />
        </Box>
        <Button
          variant="contained"
          disabled={!formValid}
          onClick={handleSearchClick}
          startIcon={<SearchIcon sx={{ fontSize: '16px !important' }} />}
          sx={{ textTransform: 'none', fontWeight: 600, height: 40, whiteSpace: 'nowrap' }}
        >
          Search
        </Button>
      </Box>
    </Paper>
  );
};

export default SearchMask;
