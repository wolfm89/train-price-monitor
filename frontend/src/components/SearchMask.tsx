import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  TextField,
  Grid,
  Typography,
  Autocomplete,
  Paper,
  Box,
  InputAdornment,
  Collapse,
  ToggleButton,
  ToggleButtonGroup,
  Chip,
  FormControl,
  Select,
  MenuItem,
  Switch,
  SelectChangeEvent,
} from '@mui/material';
import {
  Search as SearchIcon,
  LocationOn as LocationOnIcon,
  CalendarToday as CalendarTodayIcon,
  AccessTime as AccessTimeIcon,
  TuneRounded as TuneIcon,
} from '@mui/icons-material';
import { useQuery } from 'urql';
import debounce from 'lodash/debounce';
import { LocationSearchQuery } from '../api/location';
import { SearchData } from './SearchResult';

export interface ProductFilter {
  nationalExpress?: boolean;
  national?: boolean;
  regionalExpress?: boolean;
  regional?: boolean;
  suburban?: boolean;
  bus?: boolean;
  ferry?: boolean;
  subway?: boolean;
  tram?: boolean;
  taxi?: boolean;
}

export interface JourneySearchOptions {
  firstClass?: boolean;
  products?: ProductFilter;
  transfers?: number;
  bike?: boolean;
}

interface Props {
  setSearchData: (searchData: SearchData) => void;
  onSearch: (from: string, to: string, departure: string, options?: JourneySearchOptions) => void;
}

interface Location {
  id: string;
  name: string;
}

const PRODUCT_TOGGLES: { key: keyof ProductFilter; label: string }[] = [
  { key: 'nationalExpress', label: 'ICE' },
  { key: 'national', label: 'IC/EC' },
  { key: 'regionalExpress', label: 'RE' },
  { key: 'regional', label: 'RB' },
  { key: 'suburban', label: 'S-Bahn' },
  { key: 'bus', label: 'Bus' },
  { key: 'ferry', label: 'Ferry' },
  { key: 'subway', label: 'U-Bahn' },
  { key: 'tram', label: 'Tram' },
  { key: 'taxi', label: 'Taxi' },
];

const TRANSFER_OPTIONS = [
  { value: -1, label: 'Any' },
  { value: 0, label: 'Direct only' },
  { value: 1, label: '1 transfer' },
  { value: 2, label: '2 transfers' },
  { value: 3, label: '3 transfers' },
  { value: 5, label: '5 transfers' },
];

const fieldLabelSx = {
  display: 'block',
  mb: 0.5,
};

function dedupLocations(items: readonly Location[]): Location[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

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

  // Search options state
  const [showOptions, setShowOptions] = useState(false);
  const [firstClass, setFirstClass] = useState(false);
  const [enabledProducts, setEnabledProducts] = useState<Set<keyof ProductFilter>>(
    () => new Set(PRODUCT_TOGGLES.map((p) => p.key))
  );
  const [maxTransfers, setMaxTransfers] = useState<number>(-1);
  const [bike, setBike] = useState(false);

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
      setFromSuggestions(dedupLocations(fromData.locations));
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
      setToSuggestions(dedupLocations(toData.locations));
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

  const buildSearchOptions = (): JourneySearchOptions | undefined => {
    const opts: JourneySearchOptions = {};
    let hasOpts = false;

    if (firstClass) {
      opts.firstClass = true;
      hasOpts = true;
    }

    // Only include products filter when some (but not all and not zero) modes are selected
    const allSelected = enabledProducts.size === PRODUCT_TOGGLES.length;
    const noneSelected = enabledProducts.size === 0;
    if (!allSelected && !noneSelected) {
      const products: ProductFilter = {};
      for (const p of PRODUCT_TOGGLES) {
        products[p.key] = enabledProducts.has(p.key);
      }
      opts.products = products;
      hasOpts = true;
    }

    if (maxTransfers >= 0) {
      opts.transfers = maxTransfers;
      hasOpts = true;
    }

    if (bike) {
      opts.bike = true;
      hasOpts = true;
    }

    return hasOpts ? opts : undefined;
  };

  const handleSearchClick = () => {
    setSearchData({
      departure: from?.name ?? '',
      destination: to?.name ?? '',
      date: departureDay,
      time: departureTime,
    });
    onSearch(
      from?.id ?? '',
      to?.id ?? '',
      createISODateString(departureDay.trim(), departureTime.trim()),
      buildSearchOptions()
    );
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

  const handleProductToggle = (key: keyof ProductFilter) => {
    setEnabledProducts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleEnableAllProducts = () => {
    setEnabledProducts(new Set(PRODUCT_TOGGLES.map((p) => p.key)));
  };

  const handleClearAllProducts = () => {
    setEnabledProducts(new Set());
  };

  const handleTransfersChange = (e: SelectChangeEvent<number>) => {
    setMaxTransfers(Number(e.target.value));
  };

  const optionsActive = firstClass || enabledProducts.size < PRODUCT_TOGGLES.length || maxTransfers >= 0 || bike;

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
            getOptionKey={(option: Location) => option.id}
            onChange={(_event: React.SyntheticEvent, newValue: Location | null) => {
              setFromSuggestions(
                newValue
                  ? dedupLocations([newValue, ...(fromSuggestions ?? [])])
                  : dedupLocations(fromSuggestions ?? [])
              );
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
            getOptionKey={(option: Location) => option.id}
            onChange={(_event: React.SyntheticEvent, newValue: Location | null) => {
              setToSuggestions(
                newValue ? dedupLocations([newValue, ...(toSuggestions ?? [])]) : dedupLocations(toSuggestions ?? [])
              );
              setTo(newValue);
            }}
            onInputChange={(_event, newInputValue) => {
              setToInput(newInputValue);
            }}
          />
        </Grid>
      </Grid>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '200px 150px 1fr auto' },
          gap: 1.5,
          alignItems: 'end',
        }}
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
        {/* Flexible spacer — visible on sm+ only */}
        <Box sx={{ display: { xs: 'none', sm: 'block' } }} />
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

      {/* Options toggle */}
      <Box sx={{ mt: 1.5 }}>
        <Button
          size="small"
          startIcon={<TuneIcon sx={{ fontSize: '14px !important' }} />}
          onClick={() => setShowOptions((prev) => !prev)}
          sx={{
            fontSize: 12,
            textTransform: 'none',
            color: optionsActive ? 'primary.main' : 'text.secondary',
            fontWeight: optionsActive ? 600 : 400,
          }}
        >
          {showOptions ? 'Hide options' : 'Search options'}
          {optionsActive && !showOptions && (
            <Chip label="active" size="small" color="primary" sx={{ ml: 0.75, height: 18, fontSize: 10 }} />
          )}
        </Button>

        <Collapse in={showOptions}>
          <Box sx={{ pt: 1.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* Travel class */}
            <Box>
              <Typography variant="fieldLabel" sx={{ mb: 1 }}>
                Travel class
              </Typography>
              <ToggleButtonGroup
                value={firstClass ? '1' : '2'}
                exclusive
                onChange={(_e, val) => {
                  if (val !== null) setFirstClass(val === '1');
                }}
                size="small"
              >
                <ToggleButton value="2" sx={{ fontSize: 12, textTransform: 'none', px: 2 }}>
                  2nd class
                </ToggleButton>
                <ToggleButton value="1" sx={{ fontSize: 12, textTransform: 'none', px: 2 }}>
                  1st class
                </ToggleButton>
              </ToggleButtonGroup>
            </Box>

            {/* Transport modes */}
            <Box>
              <Typography variant="fieldLabel" sx={fieldLabelSx}>
                Transport modes
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                <Chip
                  key="__all__"
                  label="All"
                  size="small"
                  variant={enabledProducts.size === PRODUCT_TOGGLES.length ? 'filled' : 'outlined'}
                  color={enabledProducts.size === PRODUCT_TOGGLES.length ? 'primary' : 'default'}
                  onClick={handleEnableAllProducts}
                  sx={{ fontSize: 11, cursor: 'pointer' }}
                />
                <Chip
                  key="__none__"
                  label="None"
                  size="small"
                  variant={enabledProducts.size === 0 ? 'filled' : 'outlined'}
                  color={enabledProducts.size === 0 ? 'primary' : 'default'}
                  onClick={handleClearAllProducts}
                  sx={{ fontSize: 11, cursor: 'pointer' }}
                />
                {PRODUCT_TOGGLES.map((p) => (
                  <Chip
                    key={p.key}
                    label={p.label}
                    size="small"
                    variant={enabledProducts.has(p.key) ? 'filled' : 'outlined'}
                    color={enabledProducts.has(p.key) ? 'primary' : 'default'}
                    onClick={() => handleProductToggle(p.key)}
                    sx={{ fontSize: 11, cursor: 'pointer' }}
                  />
                ))}
              </Box>
            </Box>

            {/* Transfers + Bike row */}
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '200px 1fr' }, gap: 2 }}>
              <Box>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  Max transfers
                </Typography>
                <FormControl size="small" fullWidth>
                  <Select value={maxTransfers} onChange={handleTransfersChange} sx={{ fontSize: 13 }}>
                    {TRANSFER_OPTIONS.map((opt) => (
                      <MenuItem key={opt.value} value={opt.value} sx={{ fontSize: 13 }}>
                        {opt.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  alignSelf: 'end',
                  height: 40,
                }}
              >
                <Typography sx={{ fontSize: 13, fontWeight: 500, color: 'text.primary' }}>Bicycle space</Typography>
                <Switch checked={bike} onChange={(_e, checked) => setBike(checked)} color="secondary" size="small" />
              </Box>
            </Box>

            {/* Info about profile preferences */}
            <Typography sx={{ fontSize: 11, color: 'text.secondary', fontStyle: 'italic' }}>
              Discount cards, age group, and Deutschlandticket settings from your profile are applied automatically.
            </Typography>
          </Box>
        </Collapse>
      </Box>
    </Paper>
  );
};

export default SearchMask;
